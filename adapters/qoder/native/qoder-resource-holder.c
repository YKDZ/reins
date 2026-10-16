#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

enum close_mode {
  CLOSE_NONE = 0,
  CLOSE_TERM = 1,
  CLOSE_KILL = 2,
};

struct signaled_child {
  pid_t pid;
  unsigned long long start_time;
  enum close_mode mode;
  struct signaled_child *next;
};

static volatile sig_atomic_t termination_signal = 0;

static void on_termination_signal(int signal_number) {
  termination_signal = signal_number;
}

static int write_message(const char *message) {
  size_t remaining = strlen(message);
  const char *cursor = message;
  while (remaining > 0) {
    ssize_t written = write(3, cursor, remaining);
    if (written < 0) {
      if (errno == EINTR)
        continue;
      return -1;
    }
    cursor += written;
    remaining -= (size_t)written;
  }
  return 0;
}

static int write_errno_message(const char *kind, unsigned long request_id,
                               pid_t pid, int error_number) {
  char message[192];
  int length = snprintf(message, sizeof(message), "FAILED %lu %s %ld %d\n",
                        request_id, kind, (long)pid, error_number);
  if (length < 0 || (size_t)length >= sizeof(message)) {
    errno = EOVERFLOW;
    return -1;
  }
  return write_message(message);
}

static unsigned long long monotonic_millis(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0)
    return 0;
  return (unsigned long long)now.tv_sec * 1000ULL +
         (unsigned long long)now.tv_nsec / 1000000ULL;
}

static int child_start_time(pid_t pid, unsigned long long *start_time,
                            char *state) {
  char path[128];
  char contents[4096];
  int length = snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  if (length < 0 || (size_t)length >= sizeof(path)) {
    errno = EOVERFLOW;
    return -1;
  }
  int descriptor = open(path, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0)
    return -1;
  ssize_t count = read(descriptor, contents, sizeof(contents) - 1);
  int read_error = errno;
  close(descriptor);
  if (count < 0) {
    errno = read_error;
    return -1;
  }
  if ((size_t)count >= sizeof(contents) - 1) {
    errno = EOVERFLOW;
    return -1;
  }
  contents[count] = '\0';

  char *close_parenthesis = strrchr(contents, ')');
  if (close_parenthesis == NULL || close_parenthesis[1] != ' ') {
    errno = EPROTO;
    return -1;
  }

  char *save = NULL;
  char *token = strtok_r(close_parenthesis + 2, " ", &save);
  unsigned int field = 0;
  unsigned long long parsed_start = 0;
  bool found_state = false;
  bool found_start = false;
  while (token != NULL) {
    if (field == 0) {
      *state = token[0];
      found_state = token[0] != '\0';
    }
    if (field == 19) {
      char *end = NULL;
      errno = 0;
      parsed_start = strtoull(token, &end, 10);
      if (errno != 0 || end == token || *end != '\0') {
        errno = EPROTO;
        return -1;
      }
      found_start = true;
      break;
    }
    field += 1;
    token = strtok_r(NULL, " ", &save);
  }
  if (!found_state || !found_start) {
    errno = EPROTO;
    return -1;
  }
  *start_time = parsed_start;
  return 0;
}

static bool is_exited_state(char state) { return state == 'Z' || state == 'X'; }

static struct signaled_child *find_signaled(struct signaled_child *head,
                                            pid_t pid,
                                            unsigned long long start_time) {
  for (struct signaled_child *entry = head; entry != NULL;
       entry = entry->next) {
    if (entry->pid == pid && entry->start_time == start_time)
      return entry;
  }
  return NULL;
}

static int remember_signal(struct signaled_child **head, pid_t pid,
                           unsigned long long start_time,
                           enum close_mode mode) {
  struct signaled_child *entry = find_signaled(*head, pid, start_time);
  if (entry == NULL) {
    entry = calloc(1, sizeof(*entry));
    if (entry == NULL) return -1;
    entry->pid = pid;
    entry->start_time = start_time;
    entry->next = *head;
    *head = entry;
  }
  entry->mode = mode;
  return 0;
}

static int reap_children(pid_t root_pid, bool *root_reaped, int *root_status,
                         bool *no_children) {
  *no_children = false;
  while (true) {
    int status = 0;
    pid_t reaped = waitpid(-1, &status, WNOHANG);
    if (reaped > 0) {
      if (reaped == root_pid) {
        *root_reaped = true;
        *root_status = status;
      }
      continue;
    }
    if (reaped == 0)
      return 0;
    if (errno == EINTR)
      continue;
    if (errno == ECHILD) {
      *no_children = true;
      return 0;
    }
    return -1;
  }
}

static int read_direct_children(pid_t holder_pid, pid_t **children,
                                size_t *count) {
  char path[128];
  char contents[65536];
  int length = snprintf(path, sizeof(path), "/proc/self/task/%ld/children",
                        (long)holder_pid);
  if (length < 0 || (size_t)length >= sizeof(path)) {
    errno = EOVERFLOW;
    return -1;
  }
  int descriptor = open(path, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0)
    return -1;
  ssize_t bytes = read(descriptor, contents, sizeof(contents) - 1);
  int read_error = errno;
  close(descriptor);
  if (bytes < 0) {
    errno = read_error;
    return -1;
  }
  if ((size_t)bytes >= sizeof(contents) - 1) {
    errno = ENOBUFS;
    return -1;
  }
  contents[bytes] = '\0';

  size_t capacity = 8;
  size_t used = 0;
  pid_t *result = malloc(capacity * sizeof(*result));
  if (result == NULL)
    return -1;
  char *save = NULL;
  for (char *token = strtok_r(contents, " \t\r\n", &save); token != NULL;
       token = strtok_r(NULL, " \t\r\n", &save)) {
    char *end = NULL;
    errno = 0;
    long value = strtol(token, &end, 10);
    if (errno != 0 || end == token || *end != '\0' || value <= 0 ||
        value > INT32_MAX) {
      free(result);
      errno = EPROTO;
      return -1;
    }
    if (used == capacity) {
      capacity *= 2;
      pid_t *grown = realloc(result, capacity * sizeof(*result));
      if (grown == NULL) {
        free(result);
        return -1;
      }
      result = grown;
    }
    result[used++] = (pid_t)value;
  }
  *children = result;
  *count = used;
  return 0;
}

static int send_signal_to_children(pid_t holder_pid, enum close_mode mode,
                                   struct signaled_child **signaled,
                                   pid_t *failed_pid) {
  pid_t *children = NULL;
  size_t count = 0;
  if (read_direct_children(holder_pid, &children, &count) != 0)
    return -1;
  int signal_number = mode == CLOSE_KILL ? SIGKILL : SIGTERM;

  for (size_t index = 0; index < count; index += 1) {
    pid_t pid = children[index];
    unsigned long long start_time = 0;
    char state = '\0';
    if (child_start_time(pid, &start_time, &state) != 0) {
      if (errno == ENOENT || errno == ESRCH)
        continue;
      *failed_pid = pid;
      free(children);
      return -1;
    }
    if (is_exited_state(state))
      continue;
    struct signaled_child *previous =
        find_signaled(*signaled, pid, start_time);
    if (previous != NULL && previous->mode >= mode)
      continue;
    if (kill(pid, signal_number) != 0) {
      if (errno == ESRCH)
        continue;
      *failed_pid = pid;
      free(children);
      return -1;
    }
    if (remember_signal(signaled, pid, start_time, mode) != 0) {
      *failed_pid = pid;
      free(children);
      return -1;
    }
  }
  free(children);
  return 0;
}

static int reply_ack(unsigned long request_id) {
  char message[96];
  int length = snprintf(message, sizeof(message), "ACK %lu\n", request_id);
  if (length < 0 || (size_t)length >= sizeof(message)) {
    errno = EOVERFLOW;
    return -1;
  }
  return write_message(message);
}

static int parse_command(char *line, char **kind, unsigned long *request_id,
                         char **signal_name) {
  char *save = NULL;
  *kind = strtok_r(line, " \t\r\n", &save);
  char *id = strtok_r(NULL, " \t\r\n", &save);
  *signal_name = strtok_r(NULL, " \t\r\n", &save);
  if (*kind == NULL || id == NULL) {
    errno = EPROTO;
    return -1;
  }
  char *end = NULL;
  errno = 0;
  *request_id = strtoul(id, &end, 10);
  if (errno != 0 || end == id || *end != '\0') {
    errno = EPROTO;
    return -1;
  }
  if ((strcmp(*kind, "CLOSE") == 0 && *signal_name == NULL) ||
      (strcmp(*kind, "ABORT") == 0 && *signal_name != NULL) ||
      (strcmp(*kind, "CLOSE") != 0 && strcmp(*kind, "ABORT") != 0)) {
    errno = EPROTO;
    return -1;
  }
  return 0;
}

static int handle_command(char *line, unsigned long *request_id,
                          enum close_mode *mode, bool *awaiting_retry,
                          unsigned long *active_request_id,
                          unsigned long long *term_deadline) {
  char *kind = NULL;
  char *signal_name = NULL;
  if (parse_command(line, &kind, request_id, &signal_name) != 0)
    return -1;
  if (strcmp(kind, "ABORT") == 0) return reply_ack(*request_id);
  enum close_mode requested =
      strcmp(signal_name, "KILL") == 0
          ? CLOSE_KILL
          : strcmp(signal_name, "TERM") == 0 ? CLOSE_TERM : CLOSE_NONE;
  if (requested == CLOSE_NONE) {
    errno = EPROTO;
    return -1;
  }
  if (requested > *mode)
    *mode = requested;
  *awaiting_retry = false;
  *active_request_id = *request_id;
  *term_deadline = requested == CLOSE_TERM ? monotonic_millis() + 60ULL : 0;
  return reply_ack(*request_id);
}

static int close_runtime(int argc, char **argv) {
  if (argc < 4 || strcmp(argv[1], "--") != 0) {
    errno = EINVAL;
    return 64;
  }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    int error_number = errno;
    write_errno_message("subreaper", 0, getpid(), error_number);
    return 70;
  }

  struct sigaction termination_action;
  memset(&termination_action, 0, sizeof(termination_action));
  termination_action.sa_handler = on_termination_signal;
  sigemptyset(&termination_action.sa_mask);
  if (sigaction(SIGTERM, &termination_action, NULL) != 0 ||
      sigaction(SIGINT, &termination_action, NULL) != 0) {
    int error_number = errno;
    write_errno_message("signal-handler", 0, getpid(), error_number);
    return 70;
  }
  struct sigaction child_action;
  memset(&child_action, 0, sizeof(child_action));
  child_action.sa_handler = SIG_DFL;
  sigemptyset(&child_action.sa_mask);
  if (sigaction(SIGCHLD, &child_action, NULL) != 0) {
    int error_number = errno;
    write_errno_message("signal-handler", 0, getpid(), error_number);
    return 70;
  }
  struct sigaction pipe_action;
  memset(&pipe_action, 0, sizeof(pipe_action));
  pipe_action.sa_handler = SIG_IGN;
  sigemptyset(&pipe_action.sa_mask);
  if (sigaction(SIGPIPE, &pipe_action, NULL) != 0) {
    int error_number = errno;
    write_errno_message("signal-handler", 0, getpid(), error_number);
    return 70;
  }

  int exec_pipe[2];
  if (pipe2(exec_pipe, O_CLOEXEC) != 0) {
    int error_number = errno;
    write_errno_message("exec-pipe", 0, getpid(), error_number);
    return 70;
  }
  pid_t root_pid = fork();
  if (root_pid < 0) {
    int error_number = errno;
    close(exec_pipe[0]);
    close(exec_pipe[1]);
    write_errno_message("fork", 0, getpid(), error_number);
    return 70;
  }
  if (root_pid == 0) {
    close(exec_pipe[0]);
    close(3);
    struct sigaction default_action;
    memset(&default_action, 0, sizeof(default_action));
    default_action.sa_handler = SIG_DFL;
    sigemptyset(&default_action.sa_mask);
    sigaction(SIGTERM, &default_action, NULL);
    sigaction(SIGINT, &default_action, NULL);
    sigaction(SIGPIPE, &default_action, NULL);
    execvp(argv[2], &argv[2]);
    int error_number = errno;
    ssize_t error_bytes = write(exec_pipe[1], &error_number,
                                sizeof(error_number));
    (void)error_bytes;
    _exit(127);
  }
  close(exec_pipe[1]);
  close(STDOUT_FILENO);
  close(STDERR_FILENO);
  int exec_error = 0;
  ssize_t exec_bytes;
  do {
    exec_bytes = read(exec_pipe[0], &exec_error, sizeof(exec_error));
  } while (exec_bytes < 0 && errno == EINTR);
  int exec_read_error = errno;
  close(exec_pipe[0]);
  if (exec_bytes > 0) {
    int ignored_status = 0;
    while (waitpid(root_pid, &ignored_status, 0) < 0 && errno == EINTR) {
    }
    write_errno_message("exec", 0, root_pid, exec_error);
    return 70;
  }
  if (exec_bytes < 0) {
    int ignored_status = 0;
    kill(root_pid, SIGKILL);
    while (waitpid(root_pid, &ignored_status, 0) < 0 && errno == EINTR) {
    }
    write_errno_message("exec-status", 0, root_pid, exec_read_error);
    return 70;
  }

  char ready_message[96];
  int ready_length = snprintf(ready_message, sizeof(ready_message),
                              "READY %ld\n", (long)root_pid);
  if (ready_length < 0 || (size_t)ready_length >= sizeof(ready_message) ||
      write_message(ready_message) != 0) {
    kill(root_pid, SIGKILL);
    int ignored_status = 0;
    while (waitpid(root_pid, &ignored_status, 0) < 0 && errno == EINTR) {
    }
    return 70;
  }

  pid_t holder_pid = getpid();
  bool root_reaped = false;
  bool no_children = false;
  bool awaiting_retry = false;
  bool complete_reported = false;
  int root_status = 0;
  int command_error = 0;
  enum close_mode mode = CLOSE_NONE;
  unsigned long active_request_id = 0;
  unsigned long long term_deadline = 0;
  struct signaled_child *signaled = NULL;
  char command_buffer[1024];
  size_t command_used = 0;

  while (true) {
    if (termination_signal != 0 && mode == CLOSE_NONE) {
      mode = CLOSE_TERM;
      term_deadline = monotonic_millis() + 60ULL;
      active_request_id = 0;
    }

    if (reap_children(root_pid, &root_reaped, &root_status, &no_children) !=
        0) {
      int error_number = errno;
      write_errno_message("wait", active_request_id, -1, error_number);
      mode = CLOSE_NONE;
      awaiting_retry = true;
      active_request_id = 0;
    }

    if (root_reaped && mode == CLOSE_NONE && !no_children &&
        !awaiting_retry) {
      mode = CLOSE_TERM;
      term_deadline = monotonic_millis() + 60ULL;
      active_request_id = 0;
    }

    if (mode != CLOSE_NONE && !no_children) {
      pid_t failed_pid = -1;
      if (send_signal_to_children(holder_pid, mode, &signaled, &failed_pid) !=
          0) {
        int error_number = errno;
        const char *kind = mode == CLOSE_KILL ? "KILL" : "TERM";
        write_errno_message(kind, active_request_id, failed_pid,
                            error_number);
        mode = CLOSE_NONE;
        awaiting_retry = true;
        active_request_id = 0;
        term_deadline = 0;
      }
    }

    if (no_children && root_reaped && !awaiting_retry && !complete_reported) {
      char complete_message[96];
      int complete_length = snprintf(complete_message,
                                    sizeof(complete_message), "COMPLETE %lu\n",
                                    active_request_id);
      if (complete_length > 0 &&
          (size_t)complete_length < sizeof(complete_message) &&
          write_message(complete_message) == 0) {
        complete_reported = true;
        break;
      }
      break;
    }

    if (mode == CLOSE_TERM && term_deadline != 0 &&
        monotonic_millis() >= term_deadline) {
      mode = CLOSE_KILL;
      term_deadline = 0;
    }

    struct pollfd descriptors[1];
    descriptors[0].fd = 3;
    descriptors[0].events = POLLIN | POLLHUP;
    descriptors[0].revents = 0;
    int poll_result = poll(descriptors, 1, 20);
    if (poll_result < 0) {
      if (errno == EINTR)
        continue;
      write_errno_message("poll", active_request_id, -1, errno);
      mode = CLOSE_NONE;
      awaiting_retry = true;
      active_request_id = 0;
      continue;
    }
    if (poll_result == 0)
      continue;

    if ((descriptors[0].revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
      char chunk[512];
      ssize_t bytes = read(3, chunk, sizeof(chunk));
      if (bytes == 0) {
        if (mode == CLOSE_NONE) {
          mode = CLOSE_TERM;
          term_deadline = monotonic_millis() + 60ULL;
        }
      } else if (bytes < 0) {
        if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) {
          write_errno_message("control-read", active_request_id, -1, errno);
          mode = CLOSE_NONE;
          awaiting_retry = true;
          active_request_id = 0;
        }
      } else {
        for (ssize_t index = 0; index < bytes; index += 1) {
          char character = chunk[index];
          if (character == '\n') {
            command_buffer[command_used] = '\0';
            unsigned long request_id = 0;
            if (handle_command(command_buffer, &request_id, &mode,
                               &awaiting_retry, &active_request_id,
                               &term_deadline) != 0) {
              command_error = errno;
              write_errno_message("control", request_id, -1, command_error);
              mode = CLOSE_NONE;
              awaiting_retry = true;
              active_request_id = 0;
              term_deadline = 0;
            }
            command_used = 0;
            continue;
          }
          if (command_used + 1 >= sizeof(command_buffer)) {
            command_used = 0;
            write_errno_message("control-buffer", 0, -1, EMSGSIZE);
            mode = CLOSE_NONE;
            awaiting_retry = true;
            active_request_id = 0;
            continue;
          }
          command_buffer[command_used++] = character;
        }
      }
    }
  }

  while (signaled != NULL) {
    struct signaled_child *next = signaled->next;
    free(signaled);
    signaled = next;
  }
  if (!complete_reported)
    return 70;
  if (WIFEXITED(root_status))
    return WEXITSTATUS(root_status);
  if (WIFSIGNALED(root_status))
    return 128 + WTERMSIG(root_status);
  return 70;
}

int main(int argc, char **argv) { return close_runtime(argc, argv); }

const originalWrite = process.stdout.write.bind(process.stdout);
let injected = false;

process.stdout.write = function writeWithInjectedError(...args) {
  const result = originalWrite(...args);
  if (!injected) {
    injected = true;
    queueMicrotask(() => {
      const error = new Error("injected stdout failure");
      error.code = "EIO";
      process.stdout.emit("error", error);
    });
  }
  return result;
};

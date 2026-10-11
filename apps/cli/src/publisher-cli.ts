#!/usr/bin/env node
import { publisherMain } from "./publisher.ts";
process.exitCode = await publisherMain(process.argv.slice(2));

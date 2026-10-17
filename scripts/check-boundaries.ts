import { checkConformanceDependencyContract } from "./boundary-contract.ts";
import { runTurboBoundaries } from "./run-turbo-boundaries.ts";

checkConformanceDependencyContract(process.cwd());

process.exitCode = await runTurboBoundaries();

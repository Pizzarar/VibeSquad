// Helper process for runner-single.test.mjs: calls RunnerClient.startOwned() against argv[2] (a temp home) and prints the runner pid.
import { RunnerClient, readDiscovery } from "../../server/backend/runner-client.mjs";
const rc = new RunnerClient({ home: process.argv[2], startTimeoutMs: 20000 });
await rc.startOwned();
console.log(JSON.stringify({ pid: readDiscovery(process.argv[2])?.pid }));

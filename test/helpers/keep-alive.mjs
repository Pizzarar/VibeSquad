// Product timers (request/usage timeouts) are unref()'d on purpose. A test that awaits one would otherwise see the event
// loop drain on Node 22 ("Promise resolution is still pending but the event loop has already resolved") and the rest of the
// file get CANCELLED. Importing this holds a ref'd handle for the whole file and releases it when the file's tests finish.
import { before, after } from "node:test";

let keep;
before(() => { keep = setInterval(() => {}, 1 << 30); });
after(() => { clearInterval(keep); });

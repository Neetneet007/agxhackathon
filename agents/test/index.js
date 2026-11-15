// Entry point so that `node --test agents/test/` works: recent Node versions resolve a directory
// argument to its index.js instead of scanning it. `node --test "agents/test/*.test.js"` also works.
await import('./weather.test.js');
await import('./crash.test.js');

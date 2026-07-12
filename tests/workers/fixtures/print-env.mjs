// Test helper: prints the child process environment as one JSON line.
process.stdout.write(`${JSON.stringify({ type: "env.dump", env: process.env })}\n`);

// Test helper: emits plain environment evidence and one valid worker event.
process.stdout.write(`environment=${JSON.stringify(process.env)}\n`);
process.stdout.write(
  `${JSON.stringify({
    type: "artifact.ready",
    path: "out.txt",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  })}\n`,
);

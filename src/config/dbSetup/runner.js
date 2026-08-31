async function runStep(name, callback) {
  console.log(`Running: ${name}`);
  await callback();
  console.log(`Done: ${name}`);
}

async function runSetup(name, steps) {
  console.log(`Starting ${name} setup.`);

  for (const step of steps) {
    await runStep(step.name, step.run);
  }

  console.log(`${name} setup is ready.`);
}

module.exports = {
  runSetup,
  runStep,
};

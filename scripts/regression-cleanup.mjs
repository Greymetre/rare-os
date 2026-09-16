// Never prune global/dangling images: another project may still need them for rollback.
export async function cleanupRegression(project, run) {
  if (!/^rare-regression-[a-z0-9]+-[a-f0-9]{8}$/.test(project))
    throw Error('Refusing cleanup of a non-regression project');
  // Profiled jobs (ops) and test-only services must be removed too.
  await run([
    'compose',
    '--project-name',
    project,
    '--profile',
    '*',
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
  for (const service of ['api', 'worker', 'web', 'seed', 'migrate', 'keycloak', 'ops']) {
    const image = project + '-' + service;
    if (await run(['image', 'ls', '-q', image], true)) await run(['image', 'rm', image]);
  }
}

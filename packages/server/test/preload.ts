// Runs before every test file. Moves the default project directory (process.cwd()) into the temp root that
// script/test.ts creates, so config discovery never starts from the repository or walks up into the real HOME.
const project = process.env.OPENCODE_TEST_PROJECT
if (project) process.chdir(project)

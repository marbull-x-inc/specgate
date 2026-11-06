// react-hook-form's "web" jest project (scripts/jest/jest.config.js with TEST_ENV=web) as one
// flat config with rootDir at the project root. Stryker's jest runner does not run jest
// `projects` (each project's testEnvironment is lost), and it resolves `rootDir: '.'` against
// the config file's directory. The benchmark's test command uses TEST_ENV=web as well.
process.env.TEST_ENV = "web";
const base = require("./scripts/jest/jest.config.js");
const [web] = base.projects;
const { displayName: _displayName, ...rest } = web;

module.exports = { ...rest, rootDir: __dirname, collectCoverageFrom: base.collectCoverageFrom };

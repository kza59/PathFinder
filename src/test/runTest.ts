// Launches VS Code once per fixture folder and runs suite.ts inside it.
// Uses your installed VS Code and language extensions (Pylance, C/C++), since call hierarchy comes from them.
//   npm test                 -> all fixtures
//   npm test -- test2        -> one fixture
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { CASES } from './cases';

async function main() {
  const repo = path.resolve(__dirname, '../..');
  const requested = process.argv.slice(2);
  const fixtures = requested.length ? requested : Object.keys(CASES);
  const installed = process.env.VSCODE_EXECUTABLE ?? '/usr/share/code/code';

  let failed = 0;
  for (const fixture of fixtures) {
    try {
      await runTests({
        vscodeExecutablePath: fs.existsSync(installed) ? installed : undefined,
        extensionDevelopmentPath: repo,
        extensionTestsPath: path.join(__dirname, 'suite'),
        extensionTestsEnv: { PATHFINDER_FIXTURE: fixture },
        launchArgs: [
          path.join(repo, fixture),
          '--extensions-dir', path.join(os.homedir(), '.vscode', 'extensions'),
          '--user-data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'pathfinder-test-')),
          '--disable-extension=ms-toolsai.jupyter',
          '--disable-workspace-trust',
        ],
      });
    } catch {
      failed++;
    }
  }
  process.exit(failed ? 1 : 0);
}

main();

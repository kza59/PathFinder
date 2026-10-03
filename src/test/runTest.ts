// Launches VS Code once per fixture folder and runs suite.ts inside it.
// Uses your installed VS Code and language extensions (Pylance, C/C++), since call hierarchy comes from them.
//   npm test                 -> all fixtures
//   npm test -- test2        -> one fixture
// Progress streams live; it is also written to .vscode-test/progress.log (`tail -f` it from another terminal).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { CASES } from './cases';

function bar(done: number, total: number, width = 20): string {
  const filled = Math.round((done / total) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${done}/${total}`;
}

/** Copies whatever suite.ts appends to `file` onto our stdout, until the returned stop function is called. */
function streamFile(file: string): () => void {
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const flush = () => {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size > offset) {
      const fd = fs.openSync(file, 'r');
      const chunk = Buffer.alloc(size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      fs.closeSync(fd);
      offset = size;
      process.stdout.write(chunk.toString());
    }
  };
  const timer = setInterval(flush, 500);
  return () => {
    clearInterval(timer);
    flush();
  };
}

async function main() {
  const repo = path.resolve(__dirname, '../..');
  const requested = process.argv.slice(2);
  const fixtures = requested.length ? requested : Object.keys(CASES);
  const installed = process.env.VSCODE_EXECUTABLE ?? '/usr/share/code/code';
  const progressLog = path.join(repo, '.vscode-test', 'progress.log');
  fs.mkdirSync(path.dirname(progressLog), { recursive: true });
  fs.writeFileSync(progressLog, '');

  const results: string[] = [];
  for (const [i, fixture] of fixtures.entries()) {
    const header = `\n${bar(i, fixtures.length)}  ${fixture}  (${CASES[fixture].length} cases)\n`;
    fs.appendFileSync(progressLog, header);
    const stop = streamFile(progressLog);
    process.stdout.write(header);
    const started = Date.now();
    let ok = true;
    try {
      await runTests({
        vscodeExecutablePath: fs.existsSync(installed) ? installed : undefined,
        extensionDevelopmentPath: repo,
        extensionTestsPath: path.join(__dirname, 'suite'),
        extensionTestsEnv: { PATHFINDER_FIXTURE: fixture, PATHFINDER_LOG: progressLog, PATHFINDER_TIMEOUT: process.env.PATHFINDER_TIMEOUT },
        launchArgs: [
          path.join(repo, fixture),
          '--extensions-dir', path.join(os.homedir(), '.vscode', 'extensions'),
          '--user-data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'pathfinder-test-')),
          '--disable-extension=ms-toolsai.jupyter',
          '--disable-workspace-trust',
        ],
      });
    } catch {
      ok = false;
    } finally {
      stop();
    }
    results.push(`  ${ok ? 'PASS' : 'FAIL'}  ${fixture}  (${Math.round((Date.now() - started) / 1000)}s)`);
  }

  const summary = `\n${bar(fixtures.length, fixtures.length)}  done\n${results.join('\n')}\n`;
  fs.appendFileSync(progressLog, summary);
  process.stdout.write(summary);
  process.exit(results.some(r => r.includes('FAIL')) ? 1 : 0);
}

main();

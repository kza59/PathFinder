import type { DebugPath, GraphMessage, HistoryStep } from '../src/types';
import { fileName } from '../src/webview/filePath';

export function historyStepLabel(step: HistoryStep, index: number, count: number, dropped = 0): string {
  const where = step.where ? `${fileName(step.where.file)}:${step.where.line} ${step.where.name}` : '(no source)';
  return `Step ${index + 1} of ${count} · ${where} (${step.reason})${dropped ? ` · ${dropped} older dropped` : ''}`;
}

type Button = Pick<HTMLButtonElement, 'disabled' | 'title' | 'addEventListener'>;
interface ReplayControls {
  replay: Button;
  box: Pick<HTMLElement, 'hidden'>;
  slider: Pick<HTMLInputElement, 'disabled' | 'value' | 'max' | 'addEventListener'>;
  previous: Button;
  next: Button;
  label: Pick<HTMLElement, 'textContent'>;
}

const STEP_MS = 500;

/** Connects the footer to recorded pauses. Replay frames use the same path messages as live debugging. */
export function initializeReplayControls(
  controls: ReplayControls,
  events: EventTarget,
  showPath: (path: DebugPath) => void,
  highlightPath: (path: DebugPath) => void,
  isGraphNode: (id: string) => boolean,
): () => void {
  let steps: HistoryStep[] = [];
  let dropped = 0;
  let index = -1;
  let path: DebugPath = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restore: (() => void) | undefined;
  let sendingPath = false;

  const syncControls = () => {
    const usable = steps.length > 0;
    controls.slider.disabled = !usable;
    controls.previous.disabled = !usable || index === 0;
    controls.next.disabled = !usable || index === steps.length - 1;
    controls.replay.disabled = !usable && path.length === 0;
    controls.replay.title = usable
      ? 'Replay all recorded debugging steps'
      : 'Replay the call path, outer caller to current function';
  };
  const publishPath = (next: DebugPath) => {
    path = [...next];
    sendingPath = true;
    try { showPath(path); }
    finally { sendingPath = false; }
    syncControls();
  };
  const endedLabel = () => {
    controls.label.textContent = steps.length
      ? `Session ended · ${steps.length} ${steps.length === 1 ? 'pause' : 'pauses'} recorded · drag to scrub`
      : 'Session ended · no pauses recorded';
  };
  const stopReplay = (restoreView = false) => {
    clearTimeout(timer);
    timer = undefined;
    const saved = restore;
    restore = undefined;
    if (restoreView) saved?.();
  };
  const showStep = (next: number) => {
    if (!steps.length) return;
    index = Math.max(0, Math.min(next, steps.length - 1));
    controls.slider.value = String(index);
    controls.label.textContent = historyStepLabel(steps[index], index, steps.length, dropped);
    publishPath(steps[index].path);
  };
  const scrub = (next: number) => {
    stopReplay();
    showStep(next);
  };
  controls.slider.addEventListener('input', () => scrub(Number(controls.slider.value)));
  controls.previous.addEventListener('click', () => scrub(index < 0 ? steps.length - 1 : index - 1));
  controls.next.addEventListener('click', () => scrub(index < 0 ? 0 : index + 1));

  controls.replay.addEventListener('click', () => {
    stopReplay(true); // Clicking during playback restarts from the first recorded pause.
    if (steps.length) {
      const savedIndex = index;
      const savedPath = [...path];
      restore = () => {
        index = savedIndex;
        controls.slider.value = String(index < 0 ? steps.length - 1 : index);
        if (index < 0) endedLabel();
        else controls.label.textContent = historyStepLabel(steps[index], index, steps.length, dropped);
        publishPath(savedPath);
      };
      const play = (next: number) => {
        showStep(next);
        timer = setTimeout(() => {
          // Keep the current path visible until the next pause replaces it.
          if (next + 1 < steps.length) play(next + 1);
          else stopReplay(true);
        }, STEP_MS);
      };
      play(0);
      return;
    }
    // Preserve call-path replay while debugging or when no history has been recorded.
    const savedPath = [...path];
    if (!savedPath.length) return;
    restore = () => highlightPath(savedPath);
    const ends = savedPath.map((id, i) => isGraphNode(id) ? i + 1 : 0)
      .filter(end => end > 0 && end < savedPath.length);
    const frames = [0, ...ends, savedPath.length];
    const play = (frame: number) => {
      highlightPath(savedPath.slice(0, frames[frame]));
      if (frame + 1 < frames.length) timer = setTimeout(() => play(frame + 1), STEP_MS);
      else { timer = undefined; restore = undefined; }
    };
    play(0);
  });

  const onMessage = (event: Event) => {
    const message = (event as MessageEvent<GraphMessage>).data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'debugPath' || message.type === 'debugClear') {
      if (!sendingPath) stopReplay();
      path = message.type === 'debugPath' ? [...message.path] : [];
    } else if (message.type === 'graph') {
      stopReplay(true);
    } else if (message.type === 'sessionHistory') {
      const wasReplayingHistory = steps.length > 0 && restore !== undefined;
      stopReplay(message.state === 'ended');
      controls.box.hidden = false;
      dropped = message.dropped;
      if (message.state === 'recording') {
        steps = [];
        index = -1;
        controls.label.textContent = `Recording… ${message.count} ${message.count === 1 ? 'pause' : 'pauses'}`;
        if (wasReplayingHistory) publishPath([]);
      } else {
        steps = message.steps;
        controls.slider.max = String(Math.max(0, steps.length - 1));
        if (!steps.length) { index = -1; endedLabel(); }
        else if (index >= 0) showStep(index); // Resolve a selected pause again after a graph change.
        else {
          controls.slider.value = String(steps.length - 1);
          endedLabel();
        }
      }
    }
    syncControls();
  };
  events.addEventListener('message', onMessage);
  syncControls();
  return () => {
    stopReplay();
    events.removeEventListener('message', onMessage);
  };
}

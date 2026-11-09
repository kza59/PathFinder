import type { DebugPath, GraphData, GraphMessage, HistoryStep } from '../src/types';
import { graphPaths, type PathCatalog } from './graphPaths';
import { historyStepLabel } from './sessionReplay';

type Mode = 'overview' | 'source' | 'debug' | 'history';
export interface NavigationState {
  mode: Mode;
  path: DebugPath;
  debugPath: DebugPath;
  frame?: DebugPath;
  label: string;
  title: string;
  playing: boolean;
  hasHistory: boolean;
  canMove: boolean;
  canReplay: boolean;
  canReturn: boolean;
}

/** Arrows and playback share the same selection; nothing is selected on first open. */
export class PathNavigation {
  private catalog: PathCatalog = { paths: [], limited: false };
  private live: DebugPath = [];
  private steps: HistoryStep[] = [];
  private dropped = 0;
  private mode: Mode = 'overview';
  private index = -1;
  private timer?: ReturnType<typeof setTimeout>;
  private playing = false;
  private frame?: DebugPath;

  constructor(private readonly changed: (state: NavigationState) => void) {}

  public get state(): NavigationState {
    const path = this.mode === 'source' ? this.catalog.paths[this.index] ?? []
      : this.mode === 'history' ? this.steps[this.index]?.path ?? []
      : this.mode === 'debug' ? this.live : [];
    const count = this.steps.length || this.catalog.paths.length;
    const selectingSequence = this.mode === (this.steps.length ? 'history' : 'source');
    const label = this.mode === 'source' ? `Path ${this.index + 1} of ${this.catalog.paths.length}${this.catalog.limited ? '+' : ''}`
      : this.mode === 'history' ? `Step ${this.index + 1} of ${this.steps.length}`
      : this.mode === 'debug' ? 'Debug path'
      : this.steps.length ? `${this.steps.length} recorded ${this.steps.length === 1 ? 'step' : 'steps'}`
      : this.catalog.paths.length ? `${this.catalog.paths.length}${this.catalog.limited ? '+' : ''} ${this.catalog.paths.length === 1 ? 'path' : 'paths'}`
      : this.catalog.limited ? 'No paths found yet' : 'No paths to target';
    return {
      mode: this.mode, path: [...path], debugPath: [...(this.mode === 'overview' ? [] : this.mode === 'history' ? path : this.live)],
      frame: this.frame ? [...this.frame] : undefined, label,
      title: this.mode === 'history' ? historyStepLabel(this.steps[this.index], this.index, this.steps.length, this.dropped)
        : this.catalog.limited ? 'More source paths may exist beyond the displayed set.' : 'Choose a path with the arrows',
      playing: this.playing,
      hasHistory: this.steps.length > 0,
      canMove: count > 0 && (!selectingSequence || count > 1),
      canReplay: this.steps.length > 0 || path.length > 0,
      canReturn: this.live.length > 0 ? this.mode !== 'debug' || this.playing
        : this.steps.length > 0 && (this.mode !== 'history' || this.index !== this.steps.length - 1 || this.playing),
    };
  }

  public setGraph(graph: GraphData, targets: ReadonlySet<string>, showNoise: boolean): void {
    this.cancelPlayback();
    this.catalog = graphPaths(graph, targets, showNoise);
    // A new graph or visibility change starts from the debug path or the unselected overview.
    this.mode = this.mode === 'overview' ? 'overview' : this.live.length ? 'debug' : 'overview';
    this.index = -1;
    this.publish();
  }

  public receive(message: GraphMessage): void {
    if (message.type !== 'debugPath' && message.type !== 'debugClear' && message.type !== 'sessionHistory') return;
    this.cancelPlayback();
    if (message.type === 'debugPath' || message.type === 'debugClear') {
      this.live = message.type === 'debugPath' ? [...message.path] : [];
      this.mode = this.live.length ? 'debug' : 'overview';
      this.index = -1;
    } else {
      this.steps = message.state === 'ended'
        ? message.steps.map(step => ({ ...step, path: [...step.path] })) : [];
      this.dropped = message.dropped;
      this.mode = this.mode === 'overview' ? 'overview' : this.live.length ? 'debug' : 'overview';
      this.index = -1;
    }
    this.publish();
  }

  public move(direction: 1 | -1): void {
    const history = this.steps.length > 0;
    const count = history ? this.steps.length : this.catalog.paths.length;
    if (!count) return;
    this.cancelPlayback();
    const mode = history ? 'history' : 'source';
    this.index = this.mode !== mode || this.index < 0 ? direction === 1 ? 0 : count - 1
      : (this.index + direction + count) % count;
    this.mode = mode;
    this.publish();
  }

  public returnToDebug(): void {
    this.cancelPlayback();
    if (this.live.length) { this.mode = 'debug'; this.index = -1; }
    else if (this.steps.length) { this.mode = 'history'; this.index = this.steps.length - 1; }
    else { this.mode = 'overview'; this.index = -1; }
    this.publish();
  }

  public clearHighlights(): void {
    this.cancelPlayback();
    this.mode = 'overview';
    this.index = -1;
    this.publish();
  }

  public toggleReplay(): void {
    if (this.playing) { this.cancelPlayback(); this.publish(); return; }
    if (!this.state.canReplay) return;
    this.playing = true;
    if (this.steps.length) {
      this.index = this.mode === 'history' && this.index < this.steps.length - 1 ? this.index : 0;
      this.mode = 'history';
      const play = () => {
        this.publish();
        this.timer = setTimeout(() => {
          if (this.index + 1 < this.steps.length) { this.index++; play(); }
          else { this.cancelPlayback(); this.publish(); }
        }, 500);
      };
      play();
    } else {
      const path = this.state.path;
      let end = 1;
      const play = () => {
        this.frame = path.slice(0, end);
        this.publish();
        this.timer = setTimeout(() => {
          if (end < path.length) { end++; play(); }
          else { this.cancelPlayback(); this.publish(); }
        }, 500);
      };
      play();
    }
  }

  private publish(): void { this.changed(this.state); }
  private cancelPlayback(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.frame = undefined;
    this.playing = false;
  }
  public dispose(): void { this.cancelPlayback(); }
}

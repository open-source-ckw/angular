// client/src/app/game/game.component.ts
import {
  AfterViewInit,
  Component,
  ElementRef,
  Inject,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
} from '@angular/core';
import { AsyncPipe, isPlatformBrowser } from '@angular/common';
import type { Observable, Subscription } from 'rxjs';
import {
  SocketService,
  PublicSnapshot,
  PrivateSnapshot,
} from '../core/socket.service';
import { createTableScene } from './table.scene';

@Component({
  selector: 'app-game',
  imports: [AsyncPipe],
  template: `
    <!-- UI (can re-render freely) -->
    @if (public$ | async; as pub) {
      @if (private$ | async; as priv) {
        <div class="toolbar">
          <button (click)="join()">Join</button>
          <button (click)="start()">Start</button>
          <!-- <button (click)="discardFirst(priv)">Discard first tile</button> -->
          <button (click)="endGame()">End Game</button>

          <span class="meta">
            Phase: {{ pub.phase }} |
            Turn: {{ pub.currentTurnSeat }} |
            Wall: {{ pub.wallCount }} |
            v{{ pub.version }}
          </span>

          @if (lastError) {
            <span class="err">{{ lastError }}</span>
          }
        </div>

        @if (pub.phase === 'passing') {
          <div class="passbar">
            <div class="passhead">
              Passing: select {{ pub.pass?.count ?? 3 }} tiles
              ({{ pub.pass?.direction ?? 'left' }})
            </div>

            <div class="tiles">
              @for (t of priv.hand; track $index; let i = $index) {
                <button
                  class="tile"
                  [class.sel]="selectedIdx.has(i)"
                  (click)="toggleSelect(i, pub)"
                >
                  {{ t }}
                </button>
              }
            </div>

            <button
              (click)="submitPass(pub, priv)"
              [disabled]="selectedIdx.size !== (pub.pass?.count ?? 3)"
            >
              Submit Pass
            </button>
          </div>
        }

       @if (pub.phase === 'playing') {
          <div class="passbar">
            <div class="passhead">
              Turn stage: {{ pub.turnStage }}
              @if (priv.seatIndex === pub.currentTurnSeat) {
                | Your turn
              }@else {
                | Waiting…
              }
            </div>
            @if (priv.seatIndex === pub.currentTurnSeat && pub.turnStage !== 'NEED_DISCARD') {
              <div class="tiles">
                <button class="tile" (click)="pick()" [disabled]="!canPick(pub, priv)">
                  Pick
                </button>
              </div>
            }
          </div>
        }

        @if (pub.phase === 'claim' && priv.claimOptions) {
          <div class="passbar">
            <div class="passhead">
              Claim tile: {{ pub.claim?.tileId }} (from seat {{ pub.claim?.fromSeat }})
            </div>

            <div class="tiles">
             @if (priv.claimOptions.canPung || priv.claimOptions.canKong) {
                <button class="tile" (click)="claimPass()">Pass</button>
              }
              @if (priv.claimOptions.canPung) {
                <button class="tile" (click)="claimPung()">Pung</button>
              }

              @if (priv.claimOptions.canKong) {
                <button class="tile" (click)="claimKong()">Kong</button>
              }

              @if (priv.claimOptions.canMahjong) {
                <button class="tile">Mahjong</button>
              } @else {
                <button class="tile" disabled>Mahjong (next)</button>
              }
            </div>
          </div>
        }
      }
    } @else {
      <div class="toolbar">
        <button (click)="join()">Join</button>
        <span class="meta">Waiting for snapshots…</span>
      </div>
    }

    <!-- IMPORTANT: Phaser host must NEVER be inside @if -->
    <div #host class="host"></div>
  `,
  styles: [
    `
      .toolbar {
        display: flex;
        gap: 12px;
        padding: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .meta {
        opacity: 0.85;
        font-size: 12px;
      }
      .err {
        color: #ffb3b3;
        font-size: 12px;
      }

      /* Make sure host has real size */
      .host {
        width: 100%;
        height: calc(100vh - 56px);
      }

      .passbar {
        padding: 12px;
        border-top: 1px solid #2b5;
        background: rgba(0, 0, 0, 0.25);
      }
      .passhead {
        margin-bottom: 8px;
      }
      .tiles {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 10px 0;
      }
      .tile {
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid #486;
        background: #113;
        color: #fff;
        cursor: pointer;
      }
      .tile.sel {
        border-color: #9f9;
        background: #162;
      }
    `,
  ],
})
export class GameComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;

  public$!: Observable<PublicSnapshot | null>;
  private$!: Observable<PrivateSnapshot | null>;

  lastError: string | null = null;

  selectedIdx = new Set<number>();

  private readonly isBrowser: boolean;

  private game: any;
  private scene: any;

  private subPub?: Subscription;
  private subPriv?: Subscription;

  private roomId = 'room-1';
  private playerId = 'player-A';

  constructor(
    private sock: SocketService,
    @Inject(PLATFORM_ID) platformId: object,
  ) {
    // Fix "used before initialization"
    this.public$ = this.sock.public$.asObservable();
    this.private$ = this.sock.private$.asObservable();
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngOnInit(): void {
    this.subPub = this.sock.public$.subscribe((pub) => {
      if (!pub) return;
      if (pub.phase !== 'passing') this.selectedIdx.clear();
    });

    this.subPriv = this.sock.private$.subscribe((priv) => {
      if (!priv) return;
      const max = priv.hand.length - 1;
      for (const i of Array.from(this.selectedIdx)) {
        if (i < 0 || i > max) this.selectedIdx.delete(i);
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    if (!this.isBrowser) return; // SSR safe

    const PhaserMod = await import('phaser');
    const Phaser: any = (PhaserMod as any).default ?? PhaserMod;

    const TableSceneClass = createTableScene(Phaser, {
      onHandTileClick: (tileId: string, handIndex: number) => {
        const pub = this.sock.public$.value;
        const priv = this.sock.private$.value;
        if (!pub || !priv) return;

        // Passing: let Angular selection UI handle it (we can sync later)
        if (pub.phase === 'passing') return;

        // Playing: discard when it's your turn
        if (pub.phase === 'playing'  && pub.turnStage === 'NEED_DISCARD' && priv.seatIndex === pub.currentTurnSeat) {
          void this.sock.discard(this.roomId, this.playerId, tileId);
        }
      },
    });
    this.scene = new TableSceneClass();

    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: this.host.nativeElement,
      width: 1024,
      height: 768,
      scene: [this.scene],
      backgroundColor: '#0b3d2e',
      scale: { mode: Phaser.Scale.RESIZE },
    });

    // Feed snapshots (scene will now render them even if received early after we patch table.scene)
    this.sock.public$.subscribe((pub) => {
      const priv = this.sock.private$.value;
      this.scene?.setSnapshots(pub, priv);
    });

    this.sock.private$.subscribe((priv) => {
      const pub = this.sock.public$.value;
      this.scene?.setSnapshots(pub, priv);
    });
  }

  join(): void {
    void this.sock.join(this.roomId, this.playerId);
  }

  async start(): Promise<void> {
    this.lastError = null;
    try {
      const ack = await this.sock.startGame(this.roomId, this.playerId);
      if (!ack.ok) this.lastError = ack.error ?? 'ERR';
    } catch {
      this.lastError = 'START_TIMEOUT_OR_DISCONNECT';
    }
  }

  discardFirst(priv: PrivateSnapshot): void {
    if (!priv?.hand?.length) return;
    void this.sock.discard(this.roomId, this.playerId, priv.hand[0]);
  }

  toggleSelect(i: number, pub: PublicSnapshot): void {
    if (pub.phase !== 'passing') return;
    const need = pub.pass?.count ?? 3;

    if (this.selectedIdx.has(i)) {
      this.selectedIdx.delete(i);
      return;
    }
    if (this.selectedIdx.size >= need) return;
    this.selectedIdx.add(i);
  }

  async pick(): Promise<void> {
    this.lastError = null;
    try {
      const ack = await this.sock.pick(this.roomId, this.playerId);
      if (!ack.ok) this.lastError = ack.error ?? 'PICK_FAILED';
    } catch {
      this.lastError = 'PICK_TIMEOUT_OR_DISCONNECT';
    }
  }

  canPick(pub: PublicSnapshot | null, priv: PrivateSnapshot | null): boolean {
    if (!pub || !priv) return false;
    return pub.phase === 'playing' && pub.turnStage === 'NEED_PICK' && priv.seatIndex === pub.currentTurnSeat;
  }

  async submitPass(pub: PublicSnapshot, priv: PrivateSnapshot): Promise<void> {
    this.lastError = null;
    const need = pub.pass?.count ?? 3;
    if (this.selectedIdx.size !== need) return;

    const tiles = Array.from(this.selectedIdx).map((i) => priv.hand[i]);

    try {
      const ack = await this.sock.passSubmit(this.roomId, this.playerId, tiles);
      if (!ack.ok) {
        this.lastError = ack.error ?? 'PASS_FAILED';
        return;
      }
      this.selectedIdx.clear();
    } catch {
      this.lastError = 'PASS_TIMEOUT_OR_DISCONNECT';
    }
  }

  claimPass(): void {
    void this.sock.claimPass(this.roomId, this.playerId);
  }
  claimPung(): void {
    void this.sock.claimPung(this.roomId, this.playerId);
  }
  claimKong(): void {
    void this.sock.claimKong(this.roomId, this.playerId);
  }


  private isJoker(tileId: string): boolean {
  // match whatever you use in tile ids: "J", "JOKER", etc.
  return tileId === 'J' || tileId === 'JOKER';
}

canPung(pub: PublicSnapshot, priv: PrivateSnapshot): boolean {
  const t = pub.claim?.tileId;
  if (!t) return false;

  const same = priv.hand.filter((x) => x === t).length;
  const jokers = priv.hand.filter((x) => this.isJoker(x)).length;

  // Need 2 tiles from hand to complete pung with the claimed discard
  return same + jokers >= 2;
}

canKong(pub: PublicSnapshot, priv: PrivateSnapshot): boolean {
  const t = pub.claim?.tileId;
  if (!t) return false;

  const same = priv.hand.filter((x) => x === t).length;
  const jokers = priv.hand.filter((x) => this.isJoker(x)).length;

  // Need 3 tiles from hand to complete kong with the claimed discard
  return same + jokers >= 3;
}

  canPungOLD(pub: PublicSnapshot, priv: PrivateSnapshot): boolean {
    const t = pub.claim?.tileId;
    if (!t) return false;
    const c = priv.hand.filter((x) => x === t).length;
    return c >= 2;
  }

  canKongOLD(pub: PublicSnapshot, priv: PrivateSnapshot): boolean {
    const t = pub.claim?.tileId;
    if (!t) return false;
    const c = priv.hand.filter((x) => x === t).length;
    return c >= 3;
  }
  async endGame(): Promise<void> {
    this.lastError = null;
    try {
      const ack = await this.sock.endGame(this.roomId, this.playerId);
      if (!ack.ok) this.lastError = ack.error ?? 'END_FAILED';
      this.selectedIdx.clear();
    } catch {
      this.lastError = 'END_TIMEOUT_OR_DISCONNECT';
    }
  }

  ngOnDestroy(): void {
    this.subPub?.unsubscribe();
    this.subPriv?.unsubscribe();
    if (this.isBrowser) this.game?.destroy(true);
  }
}


/* import {
  AfterViewInit,
  Component,
  ElementRef,
  Inject,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Subscription } from 'rxjs';
import { SocketService } from '../core/socket.service';
import { createTableScene } from './table.scene';
import { loadPhaser } from './phaser.loader';

@Component({
  selector: 'app-game',
  template: `
  <div class="toolbar">
    <button (click)="join()">Join</button>
    <button (click)="start()">Start</button>
    <button (click)="discardFirst()">Discard first tile</button>
    @if (lastError) {
      <span class="err">{{ lastError }}</span>
    }
  </div>
  
  @if (isPassing) {
    <div class="passbar">
      <div>Passing: select {{ passCount }} tiles</div>

      <div class="tiles">
         @for (t of hand; track t) {
          <button
            class="tile"
            [class.sel]="selectedIdx.has($index)"
            (click)="toggleSelectIndex($index)"
          >
            {{ t }}
          </button>
         }
      </div>

      <button (click)="submitPass()" [disabled]="selectedIdx.size !== passCount">
        Submit Pass
      </button>
    </div>
  }

  <div #host class="host"></div>
`,
styles: [`
  .toolbar { display:flex; gap:12px; padding:12px; align-items:center; }
  .host { width: 100%; height: calc(100vh - 56px); }
  .err { color: #ffb3b3; font-size: 13px; }
  .passbar { padding: 12px; border-top: 1px solid #2b5; background: rgba(0,0,0,.25); }
  .tiles { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0; }
  .tile { padding:6px 10px; border-radius:8px; border:1px solid #486; background:#113; color:#fff; cursor:pointer; }
  .tile.sel { border-color:#9f9; background:#162; }
`],
})
export class GameComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;

  private isBrowser: boolean;

  private game: any | null = null; // Phaser.Game, but keep 'any' to avoid SSR import typing drama
  private scene?: any;
  private sub?: Subscription;
  private subPriv?: Subscription;
  lastError: string | null = null;
  selected = new Set<string>();

  selectedIdx = new Set<number>();
  hand: string[] = [];
  isPassing = false;
  passCount = 3;
  trackByIndex = (i: number) => i;


  private roomId = 'room-1';
  private playerId = 'player-A';

  constructor(
    private sock: SocketService,
    @Inject(PLATFORM_ID) platformId: object,
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
     console.log('IS BROWSER', this.isBrowser);
  }

  ngOnInit(): void {
    // Socket subscriptions are fine on server, but Phaser must not run.
    /* this.sub = this.sock.public$.subscribe((pub) => {
      const priv = this.sock.private$.value;
      this.scene?.setSnapshots(pub, priv);
    });

    this.subPriv = this.sock.private$.subscribe((priv) => {
      const pub = this.sock.public$.value;
      this.scene?.setSnapshots(pub, priv);
    }); */
    /*this.sub = this.sock.public$.subscribe((pub) => {
      const priv = this.sock.private$.value;
      this.scene?.setSnapshots(pub, priv);

      this.isPassing = pub?.phase === 'passing';
      this.passCount = pub?.pass?.count ?? 3;

      // ✅ if passing ended, clear selection
      if (!this.isPassing) this.selectedIdx.clear();
    });

    this.sock.private$.subscribe((priv) => {
      const pub = this.sock.public$.value;
      this.scene?.setSnapshots(pub, priv);

      this.hand = priv?.hand ?? [];

      // ✅ prune invalid indices after hand changes
      for (const i of Array.from(this.selectedIdx)) {
        if (i < 0 || i >= this.hand.length) this.selectedIdx.delete(i);
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    console.log('BROWSER', this.isBrowser);
    
    if (!this.isBrowser) return;

    // ✅ Dynamic import so Phaser doesn't execute on the server
    const Phaser = await loadPhaser();
    const TableScene = createTableScene(Phaser);
    this.scene = new TableScene();

    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: this.host.nativeElement,
      width: this.host.nativeElement.clientWidth || 1024,
      height: this.host.nativeElement.clientHeight || 768,
      scene: [this.scene],
      backgroundColor: '#0b3d2e',
      scale: { mode: Phaser.Scale.RESIZE },
    });
  }

  join(): void {
    this.sock.join(this.roomId, this.playerId);
  }

  async start() {
    try {
      const ack = await this.sock.startGame(this.roomId, this.playerId);
      this.lastError = ack.ok ? null : (ack.error ?? 'ERR');
    } catch {
      this.lastError = 'START_TIMEOUT_OR_DISCONNECT';
    }
  }

  discardFirst(): void {
    const priv = this.sock.private$.value;
    if (!priv?.hand?.length) return;
    this.sock.discard(this.roomId, this.playerId, priv.hand[0]);
  }

  /* get hand(): string[] {
    return this.sock.private$.value?.hand ?? [];
  }

  get isPassing(): boolean {
    return this.sock.public$.value?.phase === 'passing';
  }

  get passCount(): number {
    return this.sock.public$.value?.pass?.count ?? 3;
  } */
  /*toggleSelect(tile: string): void {
    if (!this.isPassing) return;

    if (this.selected.has(tile)) {
      this.selected.delete(tile);
      return;
    }

    // prevent selecting more than needed
    if (this.selected.size >= this.passCount) return;
    this.selected.add(tile);
  }

  toggleSelectIndex(i: number): void {
    if (!this.isPassing) return;

    if (this.selectedIdx.has(i)) {
      this.selectedIdx.delete(i);
      return;
    }
    if (this.selectedIdx.size >= this.passCount) return;
    this.selectedIdx.add(i);
  }

  async submitPass(): Promise<void> {
    const tiles = Array.from(this.selectedIdx).map((i) => this.hand[i]);

    // call the action you already added on server/client
    /* const ack = await this.sock.passSubmit(this.roomId, this.playerId, tiles);

    if (ack.ok) {
      // ✅ clear immediately, even before snapshot arrives
      this.selectedIdx.clear();
    } */
   /*try {
        const ack = await this.sock.passSubmit(this.roomId, this.playerId, tiles);
        if (!ack.ok) this.lastError = ack.error ?? 'PASS_FAILED';
        else this.selectedIdx.clear();
      } catch (e) {
        this.lastError = 'PASS_TIMEOUT_OR_DISCONNECT';
      }
  }
  async submitPassOLD(): Promise<void> {
    this.lastError = null;
    const tiles = Array.from(this.selected);

    try {
      const ack = await this.sock.passSubmit(this.roomId, this.playerId, tiles);
      if (!ack.ok) this.lastError = ack.error ?? 'PASS_FAILED';
      else this.selected.clear();
    } catch (e) {
      this.lastError = 'PASS_TIMEOUT_OR_DISCONNECT';
    }
  }
  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.subPriv?.unsubscribe();
    if (this.game) {
      this.game.destroy(true);
      this.game = null;
    }
  }
}
 */
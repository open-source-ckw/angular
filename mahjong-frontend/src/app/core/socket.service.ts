// client/src/app/core/socket.service.ts
import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject } from 'rxjs';

export interface PublicSnapshot {
  roomId: string;
  status: 'lobby' | 'playing' | 'finished';

  phase: 'lobby' | 'passing' | 'playing' | 'claim' | 'finished';
  turnStage: 'NEED_PICK' | 'NEED_DISCARD';

  pass?: {
    direction: 'left' | 'right' | 'across';
    count: number;
    submittedPlayerIds: string[];
  };

  claim?: {
    tileId: string;
    fromSeat: number;
    deadlineAt: number;
  };

  seats: { seatIndex: number; playerId: string; isBot: boolean }[];
  dealerSeat: number;
  currentTurnSeat: number;
  wallCount: number;
  discards: string[];
  exposures: { seatIndex: number; melds: any[] }[];
  version: number;
}

export interface PrivateSnapshot {
  playerId: string;
  seatIndex: number;
  hand: string[];
  claimOptions?: {
    canPung: boolean;
    canKong: boolean;
    canMahjong: boolean;
  };
}

export interface AckMsg {
  clientSeq: number;
  ok: boolean;
  error?: string;
  serverVersion?: number;
}

@Injectable({ providedIn: 'root' })
export class SocketService {
  private readonly socket: Socket;

  public$ = new BehaviorSubject<PublicSnapshot | null>(null);
  private$ = new BehaviorSubject<PrivateSnapshot | null>(null);

  private clientSeq = 0;

  constructor() {
    this.socket = io('https://api-mahjong-com.thatsend.app', {
      transports: ['websocket'],
      autoConnect: true,
    });

    this.socket.on('room/public', (snap: PublicSnapshot) => this.public$.next(snap));
    this.socket.on('room/private', (snap: PrivateSnapshot) => this.private$.next(snap));

    this.socket.on("connect", () =>
      console.log(`✅ Connected to :`, this.socket.id)
    );
    this.socket.on("connect_error", (err: any) =>{
      console.error("❌ Error:", err.message)
      console.error('Full error:', err);
      console.error('Error data:', err.data);
     
    });

    this.socket.on('disconnect', reason => console.log(reason));
  }

  join(roomId: string, playerId: string): void {
    this.socket.emit('room/join', { roomId, playerId });
  }

  startGame(roomId: string, playerId: string): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'START_GAME' });
  }

  passSubmit(roomId: string, playerId: string, tiles: string[]): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'PASS_SUBMIT', tiles });
  }

  pick(roomId: string, playerId: string): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'PICK' });
  }

  discard(roomId: string, playerId: string, tileId: string): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'DISCARD', tileId });
  }

  claimPass(roomId: string, playerId: string): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'CLAIM', kind: 'PASS' });
  }

  claimPung(roomId: string, playerId: string): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'CLAIM', kind: 'PUNG' });
  }

  claimKong(roomId: string, playerId: string): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'CLAIM', kind: 'KONG' });
  }

  private emitAction(
    roomId: string,
    playerId: string,
    action: unknown,
  ): Promise<AckMsg> {
    this.clientSeq += 1;

    return new Promise((resolve) => {
      this.socket.emit(
        'game/action',
        { roomId, playerId, clientSeq: this.clientSeq, action },
        (ack: AckMsg) => resolve(ack),
      );
    });
  }
  endGame(roomId: string, playerId: string): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'END_GAME' });
  }
}

/* import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject } from 'rxjs';

export type SeatInfo = { seatIndex: number; playerId: string; isBot: boolean };

export type PassInfo = {
  direction: 'left' | 'right' | 'across';
  count: number;
  submittedPlayerIds: string[];
};
export interface MeldPublic {
  kind: 'PUNG' | 'KONG';
  tileId: string;
  fromSeat: number;
  bySeat: number;
  tiles: string[];
}
export type PublicSnapshot = {
  roomId: string;
  status: 'lobby' | 'playing' | 'finished';
  phase: 'lobby' | 'passing' | 'playing' | 'claim' | 'finished';
  seats: SeatInfo[];
  dealerSeat: number;
  currentTurnSeat: number;
  wallCount: number;
  discards: string[];
  pass?: PassInfo;
  claim?: { tileId: string; fromSeat: number; deadlineAt: number };
  exposures: { seatIndex: number; melds: MeldPublic[] }[];
  version: number;
};


export interface ClaimOptions {
  canPass: boolean;
  canPung: boolean;
  canKong: boolean;
  canMahjong: boolean;
}

export interface PrivateSnapshot {
  playerId: string;
  seatIndex: number;
  hand: string[];
  claimOptions?: ClaimOptions;
}

export type JoinAck = { ok: boolean; seatIndex: number };

export type AckMsg = {
  clientSeq: number;
  ok: boolean;
  error?: string;
  serverVersion?: number;
};

// add these interfaces near the top (after snapshots)

interface StartGameAction {
  type: 'START_GAME';
}

interface DiscardAction {
  type: 'DISCARD';
  tileId: string;
}

interface PassSubmitAction {
  type: 'PASS_SUBMIT';
  tiles: string[];
}

interface ClaimAction {
  type: 'CLAIM';
  kind: 'PASS' | 'PUNG' | 'KONG' | 'MAHJONG';
}

type ClientAction = StartGameAction | DiscardAction | PassSubmitAction | ClaimAction;

export interface ActionMsg {
  roomId: string;
  playerId: string;
  clientSeq: number;
  action: ClientAction;
}


/* export type ClientAction =
  | { type: 'START_GAME' }
  | { type: 'DISCARD'; tileId: string }
  | { type: 'PASS_SUBMIT'; tiles: string[] }
 */


/*@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket: Socket;
  

  public$ = new BehaviorSubject<PublicSnapshot | null>(null);
  private$ = new BehaviorSubject<PrivateSnapshot | null>(null);

  private clientSeq = 0;

  constructor() {
    this.socket = io('http://localhost:3000', {
      transports: ['websocket'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 300,
      reconnectionDelayMax: 1500,
    });

    this.socket.on('room/public', (snap: PublicSnapshot) => this.public$.next(snap));
    this.socket.on('room/private', (snap: PrivateSnapshot) => this.private$.next(snap));
  }

  join(roomId: string, playerId: string): Promise<JoinAck> {
    return new Promise((resolve, reject) => {
      this.socket
        .timeout(5000)
        .emit('room/join', { roomId, playerId }, (err: unknown, res: JoinAck) => {
          if (err) return reject(err);
          resolve(res);
        });
    });
  }

  startGame(roomId: string, playerId: string): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'START_GAME' });
  }

  discard(roomId: string, playerId: string, tileId: string): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'DISCARD', tileId });
  }

  passSubmit(roomId: string, playerId: string, tiles: string[]): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'PASS_SUBMIT', tiles });
  }

  claimPass(roomId: string, playerId: string) {
    return this.emitAction(roomId, playerId, { type: 'CLAIM', kind: 'PASS' });
  }

  claimPung(roomId: string, playerId: string) {
    return this.emitAction(roomId, playerId, { type: 'CLAIM', kind: 'PUNG' });
  }

  claimKong(roomId: string, playerId: string) {
    return this.emitAction(roomId, playerId, { type: 'CLAIM', kind: 'KONG' });
  }

  claimMahjong(roomId: string, playerId: string) {
    return this.emitAction(roomId, playerId, { type: 'CLAIM', kind: 'MAHJONG' });
  }


  private emitAction(roomId: string, playerId: string, action: ClientAction): Promise<AckMsg> {
    this.clientSeq += 1;

    const payload: ActionMsg = {
      roomId,
      playerId,
      clientSeq: this.clientSeq,
      action,
    };

    return new Promise((resolve, reject) => {
      this.socket
        .timeout(5000)
        .emit(
          'game/action',
          { roomId, playerId, clientSeq: this.clientSeq, action },
          (err: unknown, ack: AckMsg) => {
            if (err) return reject(err);
            resolve(ack);
          },
        );
    });
  }
} */

/* import { Inject, Injectable, PLATFORM_ID, NgZone } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject } from 'rxjs';

export type SeatInfo = { seatIndex: number; playerId: string; isBot: boolean };

export type PassInfo = {
  direction: 'left' | 'right' | 'across';
  count: number;
  submittedPlayerIds: string[];
};

export type PublicSnapshot = {
  roomId: string;
  status: 'lobby' | 'playing' | 'finished';
  phase: 'lobby' | 'passing' | 'playing' | 'claim' | 'finished';

  seats: SeatInfo[];
  dealerSeat: number;
  currentTurnSeat: number;
  wallCount: number;
  discards: string[];
  pass?: PassInfo;

  version: number;
};

export type PrivateSnapshot = {
  playerId: string;
  seatIndex: number;
  hand: string[];
};

export type JoinAck = { ok: boolean; seatIndex: number };

export type AckMsg = {
  clientSeq: number;
  ok: boolean;
  error?: string;
  serverVersion?: number;
};

export type ClientAction =
  | { type: 'START_GAME' }
  | { type: 'DISCARD'; tileId: string }
  | { type: 'PASS_SUBMIT'; tiles: string[] };

@Injectable({ providedIn: 'root' })
export class SocketService {
  public$ = new BehaviorSubject<PublicSnapshot | null>(null);
  private$ = new BehaviorSubject<PrivateSnapshot | null>(null);
  lastAck$ = new BehaviorSubject<AckMsg | null>(null);

  private clientSeq = 0;

  private socket: any | null = null;
  private isBrowser: boolean;

  constructor(@Inject(PLATFORM_ID) platformId: object, private zone: NgZone) {
    this.isBrowser = isPlatformBrowser(platformId);

    if (!this.isBrowser) {
      // SSR/prerender: do nothing
      return;
    }

    // Dynamic import to avoid SSR "window" issues
    void this.initSocket();
  }

  private async initSocket(): Promise<void> {
    const { io } = await import('socket.io-client');

    this.socket = io('http://localhost:3000', {
      transports: ['websocket'],
      autoConnect: true,
    });

    // register listeners ONCE
    //this.socket.on('room/public', (snap: PublicSnapshot) => this.public$.next(snap));
    //this.socket.on('room/private', (snap: PrivateSnapshot) => this.private$.next(snap));

    this.socket.on('room/public', (snap: PublicSnapshot) => {
      this.zone.run(() => this.public$.next(snap));
    });

    this.socket.on('room/private', (snap: PrivateSnapshot) => {
      this.zone.run(() => this.private$.next(snap));
    });
  }

  async join(roomId: string, playerId: string): Promise<JoinAck> {
    this.ensureSocket();

    // Socket.IO acknowledgements: pass a callback as last arg. :contentReference[oaicite:1]{index=1}
    return new Promise<JoinAck>((resolve, reject) => {
      // timeout() pattern exists in v4 docs for request-response style emits. :contentReference[oaicite:2]{index=2}
      this.socket
        .timeout(5000)
        .emit('room/join', { roomId, playerId }, (err: unknown, res: JoinAck) => {
          if (err) return reject(err);
          resolve(res);
        });
    });
  }

  startGame(roomId: string, playerId: string): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'START_GAME' });
  }

  discard(roomId: string, playerId: string, tileId: string): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'DISCARD', tileId });
  }

  passSubmit(roomId: string, playerId: string, tiles: string[]): Promise<AckMsg> {
    return this.emitAction(roomId, playerId, { type: 'PASS_SUBMIT', tiles });
  }

  private emitAction(roomId: string, playerId: string, action: ClientAction): Promise<AckMsg> {
    this.ensureSocket();

    this.clientSeq += 1;
    const msg = {
      roomId,
      playerId,
      clientSeq: this.clientSeq,
      action,
    };

    // Client → server acknowledgement callback. :contentReference[oaicite:3]{index=3}
    return new Promise<AckMsg>((resolve, reject) => {
      this.socket
        .timeout(5000)
        .emit('game/action', msg, (err: unknown, ack: AckMsg) => {
          if (err) return reject(err);
          this.lastAck$.next(ack);
          resolve(ack);
        });
    });
  }

  private ensureSocket(): void {
    if (!this.isBrowser) {
      throw new Error('SocketService used on server (SSR). Guard your calls.');
    }
    if (!this.socket) {
      throw new Error('Socket not initialized yet.');
    }
  }
} */

/* import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject } from 'rxjs';

export type PublicSnapshot = {
  roomId: string;
  status: 'lobby' | 'playing' | 'finished';
  seats: { seatIndex: number; playerId: string; isBot: boolean }[];
  dealerSeat: number;
  currentTurnSeat: number;
  wallCount: number;
  discards: string[];
  version: number;
};

export type PrivateSnapshot = {
  playerId: string;
  seatIndex: number;
  hand: string[];
};

@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket: Socket;

  public$ = new BehaviorSubject<PublicSnapshot | null>(null);
  private$ = new BehaviorSubject<PrivateSnapshot | null>(null);

  private clientSeq = 0;

  constructor() {
    this.socket = io('http://localhost:3000', {
      transports: ['websocket'],
      autoConnect: true,
    });

    // register listeners ONCE (connect fires on reconnect too) :contentReference[oaicite:7]{index=7}
    this.socket.on('room/public', (snap: PublicSnapshot) => this.public$.next(snap));
    this.socket.on('room/private', (snap: PrivateSnapshot) => this.private$.next(snap));
  }

  join(roomId: string, playerId: string) {
    return this.socket.emit('room/join', { roomId, playerId });
  }

  startGame(roomId: string, playerId: string) {
    this.emitAction(roomId, playerId, { type: 'START_GAME' });
  }

  discard(roomId: string, playerId: string, tileId: string) {
    this.emitAction(roomId, playerId, { type: 'DISCARD', tileId });
  }

  private emitAction(roomId: string, playerId: string, action: any) {
    this.clientSeq += 1;
    this.socket.emit('game/action', {
      roomId,
      playerId,
      clientSeq: this.clientSeq,
      action,
    });
  }
} */

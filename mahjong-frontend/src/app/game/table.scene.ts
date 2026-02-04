// client/src/app/game/table.scene.ts
// client/src/app/game/table.scene.ts
import type Phaser from 'phaser';
import type { PublicSnapshot, PrivateSnapshot } from '../core/socket.service';

export interface TableSceneBridge {
  onHandTileClick?: (tileId: string, handIndex: number) => void; // we will call this ONLY for discard (double click / discard-drop)
  onPickClick?: () => void;
}

export interface TileStyle {
  w: number;
  h: number;
  r: number;
  fontSize: number;
}

interface SeatAnchor {
  x: number;
  y: number;
  dir: 'h' | 'v';
  align: 'start' | 'center' | 'end';
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function formatTileLabel(id: string): string {
  if (id === 'J' || id === 'JOKER') return 'JOKER';
  if (id === 'F') return 'FLOWER';
  if (id === 'DR') return 'DRAGON R';
  if (id === 'DG') return 'DRAGON G';
  if (id === 'DW') return 'DRAGON W';

  const m = /^([BDC])(\d+)$/.exec(id);
  if (!m) return id;
  const suit = m[1] === 'B' ? 'BAM' : m[1] === 'D' ? 'DOT' : 'CRAK';
  return `${suit} ${m[2]}`;
}

// ---- stable “instance key” for duplicates: B7_1, B7_2, etc.
function makeHandKeys(hand: string[]): { keys: string[]; keyToTileId: Map<string, string> } {
  const cnt = new Map<string, number>();
  const keys: string[] = [];
  const keyToTileId = new Map<string, string>();
  for (const t of hand) {
    const n = (cnt.get(t) ?? 0) + 1;
    cnt.set(t, n);
    const k = `${t}_${n}`;
    keys.push(k);
    keyToTileId.set(k, t);
  }
  return { keys, keyToTileId };
}

type HandTileGO = any;

export function createTableScene(PhaserNS: any, bridge?: TableSceneBridge) {
  const SceneBase = PhaserNS.Scene;

  return class TableScene extends SceneBase {
    private publicSnap: PublicSnapshot | null = null;
    private privateSnap: PrivateSnapshot | null = null;
    private created = false;

    private tileStyle: TileStyle = { w: 56, h: 76, r: 10, fontSize: 12 };

    // layers
    private bgLayer?: any;
    private seatsLayer?: any;
    private exposuresLayer?: any;
    private discardsLayer?: any;
    private handLayer?: any;
    private hudLayer?: any;

    // persistent objects
    private felt?: any;
    private infoText?: any;
    private claimBar?: any;

    // wall ui
    private wallBox?: any;
    private wallText?: any;

    // discard drop zone (center)
    private discardZone?: any;
    private discardZoneGfx?: any;

    // diff memory
    private prevHandLen = 0;
    private prevDiscardLen = 0;
    private prevPhase: string | null = null;

    // ---- persistent hand state (fixes “snapshots kill my drag”)
    private handTiles = new Map<string, HandTileGO>(); // key -> GO
    private handOrder: string[] = []; // local order of keys
    private keyToTileId = new Map<string, string>(); // key -> tileId
    private isDraggingHand = false;
    private pendingSnap: { pub: PublicSnapshot | null; priv: PrivateSnapshot | null } | null = null;

    // double click tracking
    private lastClickAt = 0;
    private lastClickKey: string | null = null;

    constructor() {
      super('table');
    }

    create(): void {
      const scene = this as unknown as Phaser.Scene;
      this.created = true;

      // input tuning (prevents accidental drags)
      // Phaser supports these thresholds on the Input Plugin. :contentReference[oaicite:4]{index=4}
      scene.input.dragDistanceThreshold = 24;
      scene.input.dragTimeThreshold = 90;
      scene.input.topOnly = true; // only pick the top-most object (prevents neighbor grabbing). :contentReference[oaicite:5]{index=5}

      // layers in order
      this.bgLayer = scene.add.container(0, 0);
      this.seatsLayer = scene.add.container(0, 0);
      this.exposuresLayer = scene.add.container(0, 0);
      this.discardsLayer = scene.add.container(0, 0);
      this.handLayer = scene.add.container(0, 0);
      this.hudLayer = scene.add.container(0, 0);

      // felt
      this.felt = scene.add.graphics();
      this.bgLayer.add(this.felt);

      // HUD
      this.infoText = scene.add.text(16, 12, 'Waiting…', { fontSize: '14px' });
      this.hudLayer.add(this.infoText);

      // discard zone ONCE
      this.discardZone = scene.add.zone(0, 0, 10, 10).setRectangleDropZone(10, 10);
      this.discardZoneGfx = scene.add.graphics();
      this.discardsLayer.add(this.discardZoneGfx);

      // Drag/drop events ONCE
      scene.input.on('dragstart', (_p: any, go: any) => {
        // only treat our hand tiles as “dragging”
        if (go?.getData?.('isHandTile')) {
          this.isDraggingHand = true;
        }
        go.setDepth?.(9999);
        scene.tweens.add({ targets: go, scaleX: 1.04, scaleY: 1.04, duration: 70 });
      });

      scene.input.on('drag', (_p: any, go: any, dragX: number, dragY: number) => {
        go.x = dragX;
        go.y = dragY;

        // while dragging inside rack, we can preview reorder by nearest slot
        const key: string | undefined = go?.getData?.('handKey');
        if (!key) return;

        // If user drags across rack area, reorder locally (no server call)
        this.previewReorder(key, dragX, dragY);
      });

      scene.input.on('drop', (_p: any, go: any, dz: any) => {
        // drop only matters if dropped onto discardZone
        if (dz !== this.discardZone) return;

        const key: string | undefined = go?.getData?.('handKey');
        if (!key) return;

        const pub = this.publicSnap;
        const priv = this.privateSnap;
        if (!pub || !priv) return;

        // discard allowed only on your turn + NEED_DISCARD
        const canDiscard =
          pub.phase === 'playing' &&
          (pub as any).turnStage === 'NEED_DISCARD' &&
          priv.seatIndex === pub.currentTurnSeat;

        if (!canDiscard) {
          // not allowed: snap back to slot
          this.snapTileToSlot(key, true);
          return;
        }

        // map key -> tileId, and compute current index from local order
        const tileId = this.keyToTileId.get(key);
        if (!tileId) return;

        const idx = this.handOrder.indexOf(key);
        bridge?.onHandTileClick?.(tileId, idx);

        // quick “discard feel” animation (server snapshot will re-render discards)
        scene.tweens.add({
          targets: go,
          x: this.centerPoint().x,
          y: this.centerPoint().y,
          alpha: 0.0,
          duration: 140,
        });
      });

      scene.input.on('dragend', (_p: any, go: any, dropped: boolean) => {
        const key: string | undefined = go?.getData?.('handKey');
        if (!key) return;

        scene.tweens.add({ targets: go, scaleX: 1, scaleY: 1, duration: 60 });

        // always snap to final slot (even if “dropped”)
        this.snapTileToSlot(key, true);

        // finish drag
        if (go?.getData?.('isHandTile')) {
          this.isDraggingHand = false;

          // apply queued snapshot after drag completes
          if (this.pendingSnap) {
            const { pub, priv } = this.pendingSnap;
            this.pendingSnap = null;
            this.publicSnap = pub;
            this.privateSnap = priv;
            this.renderAll();
          }
        }

        // IMPORTANT: if dropped onto discard zone, we still snap.
        // The server will remove the tile; this snap is just a visual reset.
        void dropped;
      });

      // Resize
      scene.scale.on(
        PhaserNS.Scale.Events.RESIZE,
        () => {
          this.layout();
          this.redrawFelt();
          this.renderAll();
        },
        this,
      );

      this.layout();
      this.redrawFelt();
      this.renderAll();
    }

    setSnapshots(pub: PublicSnapshot | null, priv: PrivateSnapshot | null): void {
      // If user is dragging a hand tile, DON’T re-render and destroy stuff mid-drag.
      // Queue and apply after dragend.
      if (this.isDraggingHand) {
        this.pendingSnap = { pub, priv };
        return;
      }

      this.publicSnap = pub;
      this.privateSnap = priv;
      if (!this.created) return;
      this.renderAll();
    }

    // ------------------------
    // Layout + background
    // ------------------------
    private layout(): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;

      const base = Math.max(44, Math.min(66, Math.floor(w / 18)));
      this.tileStyle = {
        w: base,
        h: Math.floor(base * 1.35),
        r: Math.floor(base * 0.18),
        fontSize: clamp(Math.floor(base / 4), 10, 14),
      };

      if (this.infoText) this.infoText.setPosition(16, 12);
      this.layoutWall();
      this.layoutDiscardZone();

      // snap all hand tiles to their new computed slots on resize
      this.snapAllHandTiles(false);
    }

    private redrawFelt(): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;
      if (!this.felt) return;

      this.felt.clear();
      this.felt.fillStyle(0x0b3d2e, 1);
      this.felt.fillRect(0, 0, w, h);

      this.felt.lineStyle(2, 0x083226, 1);
      this.felt.strokeRect(8, 8, w - 16, h - 16);
    }

    private centerPoint(): { x: number; y: number } {
      const scene = this as unknown as Phaser.Scene;
      return { x: Math.floor(scene.scale.width / 2), y: Math.floor(scene.scale.height / 2) };
    }

    // ------------------------
    // Render
    // ------------------------
    private renderAll(): void {
      if (!this.created) return;

      const scene = this as unknown as Phaser.Scene;
      const pub = this.publicSnap;
      const priv = this.privateSnap;

      if (!this.seatsLayer || !this.exposuresLayer || !this.discardsLayer || !this.handLayer || !this.hudLayer) {
        return;
      }

      // Clear non-hand layers (hand is persistent for UX)
      this.seatsLayer.removeAll(true);
      this.exposuresLayer.removeAll(true);
      this.discardsLayer.removeAll(true);

      // claim banner reset
      if (this.claimBar) {
        this.claimBar.destroy(true);
        this.claimBar = undefined;
      }

      // HUD
      if (this.infoText && pub) {
        this.infoText.setText(
          `Room: ${pub.roomId} | Phase: ${pub.phase} | Turn: ${pub.currentTurnSeat} | Wall: ${pub.wallCount} | v${pub.version}`,
        );
      } else if (this.infoText) {
        this.infoText.setText('Waiting…');
      }

      // Wall
      if (pub) this.drawWall(pub, priv);

      // Seats (other racks)
      if (pub && priv) this.drawOtherRacks(pub, priv);

      // Discards + exposures
      if (pub) {
        this.drawDiscardZoneVisual();
        this.drawDiscards(pub);
        this.drawExposures(pub);
      }

      // Hand (persistent objects)
      if (pub && priv) this.syncAndDrawHand(pub, priv);

      // Claim banner
      if (pub?.phase === 'claim' && pub.claim && priv) {
        if (priv.seatIndex !== pub.claim.fromSeat) {
          this.drawClaimBanner(pub.claim.tileId, pub.claim.fromSeat);
        }
      }

      // light animations
      this.applyLightAnimations(pub, priv);

      // store diffs
      this.prevHandLen = priv?.hand?.length ?? 0;
      this.prevDiscardLen = pub?.discards?.length ?? 0;
      this.prevPhase = pub?.phase ?? null;

      scene.input?.setDefaultCursor('default');
    }

    private applyLightAnimations(pub: PublicSnapshot | null, priv: PrivateSnapshot | null): void {
      const scene = this as unknown as Phaser.Scene;
      if (!pub || !priv) return;

      const handLen = priv.hand?.length ?? 0;
      if (handLen > this.prevHandLen && this.wallBox) {
        scene.tweens.add({ targets: this.wallBox, alpha: 0.4, duration: 70, yoyo: true, repeat: 2 });
      }

      const discLen = pub.discards?.length ?? 0;
      if (discLen > this.prevDiscardLen && this.discardZoneGfx) {
        scene.tweens.add({ targets: this.discardZoneGfx, alpha: 0.35, duration: 90, yoyo: true, repeat: 2 });
      }

      if (this.prevPhase && pub.phase !== this.prevPhase && this.infoText) {
        scene.tweens.add({ targets: this.infoText, alpha: 0.4, duration: 80, yoyo: true, repeat: 2 });
      }
    }

    // ------------------------
    // Wall (top-right)
    // ------------------------
    private layoutWall(): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;

      const boxW = 120;
      const boxH = 54;

      if (!this.wallBox) {
        this.wallBox = scene.add.container(0, 0);
        const g = scene.add.graphics();
        g.fillStyle(0x06261c, 0.9);
        g.fillRoundedRect(0, 0, boxW, boxH, 10);
        g.lineStyle(2, 0x0d5a43, 1);
        g.strokeRoundedRect(0, 0, boxW, boxH, 10);
        this.wallText = scene.add.text(10, 10, 'Wall: -', { fontSize: '14px' });
        this.wallBox.add([g, this.wallText]);

        // interactive hit
        const hit = scene.add.rectangle(boxW / 2, boxH / 2, boxW, boxH, 0x000000, 0);
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => bridge?.onPickClick?.());
        this.wallBox.add(hit);

        this.hudLayer?.add(this.wallBox);
      }

      this.wallBox.setPosition(w - boxW - 16, 12);
      this.wallBox.setAlpha(1);
    }

    private drawWall(pub: PublicSnapshot, priv: PrivateSnapshot | null): void {
      if (!this.wallText || !this.wallBox) return;

      this.wallText.setText(`Wall: ${pub.wallCount}`);

      const canPick =
        !!priv &&
        pub.phase === 'playing' &&
        (pub as any).turnStage === 'NEED_PICK' &&
        priv.seatIndex === pub.currentTurnSeat;

      this.wallBox.setAlpha(canPick ? 1.0 : 0.55);
    }

    // ------------------------
    // Opponent racks (placeholder)
    // ------------------------
    // ------------------------
    // Opponent racks (tile backs) + seat labels (fixed positioning)
    // ------------------------
    private drawOtherRacks(pub: PublicSnapshot, priv: PrivateSnapshot): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      // We only know our own hand. For others, show generic rack backs.
      const backCount = 13;

      const mySeat = priv.seatIndex;

      for (let seat = 0; seat < 4; seat++) {
        if (seat === mySeat) continue;

        const a = this.seatAnchor(seat, w, h);

        // rack size
        const rackW = a.dir === 'h' ? 320 : 34;
        const rackH = a.dir === 'h' ? 34 : 320;

        // Draw rack bar (background)
        const g = scene.add.graphics();
        g.fillStyle(0x152a24, 0.7);
        g.fillRoundedRect(a.x, a.y, rackW, rackH, 10);

        this.seatsLayer?.add(g);

        // ---- label text (put it ABOVE racks/exposures reliably) ----
        // Put labels on exposuresLayer so they don't get hidden and also get cleared every render.
        const labelStr = `Seat ${seat} | Tiles ~${backCount}${seat === pub.currentTurnSeat ? ' (TURN)' : ''}`;

        const txt = scene.add.text(0, 0, labelStr, { fontSize: '12px' });
        txt.setOrigin(0, 0);

        // Measure actual width/height
        const labelW = txt.width || 140;
        const labelH = txt.height || 14;

        const pad = 10;
        const screenPad = 12;

        // Preferred: label LEFT of the rack (what you asked)
        let x = a.x - pad - labelW;
        let y = a.y + (a.dir === 'h' ? 8 : 8);

        // If left would go off-screen, flip to RIGHT of the rack
        if (x < screenPad) {
          x = a.x + rackW + pad;
        }

        // Clamp so it never clips on either side
        x = clamp(x, screenPad, w - labelW - screenPad);
        y = clamp(y, 44, h - labelH - screenPad);

        txt.setPosition(x, y);

        // If you want it a bit more readable on top of tiles:
        // txt.setShadow(1, 1, '#000', 2, true, true);

        this.exposuresLayer?.add(txt);
      }
    }

    private drawOtherRacksOLD(pub: PublicSnapshot, priv: PrivateSnapshot): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      const backCount = 13; // later: add handCount in public snapshot

      const mySeat = priv.seatIndex;
      for (let seat = 0; seat < 4; seat++) {
        if (seat === mySeat) continue;

        const a = this.seatAnchor(seat, w, h);
        const g = scene.add.graphics();
        g.fillStyle(0x152a24, 0.7);

        if (a.dir === 'h') g.fillRoundedRect(a.x, a.y, 320, 34, 10);
        else g.fillRoundedRect(a.x, a.y, 34, 320, 10);


        const exp = this.exposureAnchor(seat, w, h);

        // Put the label just LEFT of the exposure area, right-aligned
        const labelX = exp.x - 10;
        const labelY = exp.y - 18;

        const txt = scene.add.text(
          labelX,
          labelY,
          `Seat ${seat} | Tiles ~${backCount}${seat === pub.currentTurnSeat ? ' (TURN)' : ''}`,
          { fontSize: '12px' },
        );

        // right-align so it hugs the exposure bar neatly
        txt.setOrigin(1, 0);

        /* const txt = scene.add.text(
          a.x + (a.dir === 'h' ? 10 : 42),
          a.y + (a.dir === 'h' ? 8 : 10),
          `Seat ${seat} | Tiles ~${backCount}${seat === pub.currentTurnSeat ? ' (TURN)' : ''}`,
          { fontSize: '12px' },
        ); */

        this.seatsLayer?.add(g);
        this.seatsLayer?.add(txt);
      }
    }

    private seatAnchor(seatIndex: number, w: number, h: number): SeatAnchor {
      if (seatIndex === 0) return { x: Math.floor(w / 2) - 160, y: h - 120, dir: 'h', align: 'center' };
      if (seatIndex === 1) return { x: w - 70, y: Math.floor(h / 2) - 160, dir: 'v', align: 'center' };
      if (seatIndex === 2) return { x: Math.floor(w / 2) - 160, y: 70, dir: 'h', align: 'center' };
      return { x: 36, y: Math.floor(h / 2) - 160, dir: 'v', align: 'center' };
    }

    private exposureAnchor(seatIndex: number, w: number, h: number): { x: number; y: number; dir: 'h' | 'v' } {
      const { w: tw, h: th } = this.tileStyle;

      switch (seatIndex) {
        case 0: return { x: 16, y: h - th * 3 - 160, dir: 'h' };
        case 1: return { x: w - tw - 16, y: Math.floor(h * 0.30), dir: 'v' };
        case 2: return { x: 16, y: 90, dir: 'h' };
        case 3: return { x: 16, y: Math.floor(h * 0.30), dir: 'v' };
        default: return { x: 16, y: 90, dir: 'h' };
      }
    }
    // ------------------------
    // Discard zone (center)
    // ------------------------
    private layoutDiscardZone(): void {
      const c = this.centerPoint();
      const zw = 260;
      const zh = 160;

      if (this.discardZone) {
        this.discardZone.x = c.x;
        this.discardZone.y = c.y;
        this.discardZone.setSize(zw, zh);
        this.discardZone.input?.hitArea?.setSize?.(zw, zh);
      }
    }

    private drawDiscardZoneVisual(): void {
      const scene = this as unknown as Phaser.Scene;
      const c = this.centerPoint();
      const zw = 260;
      const zh = 160;

      if (!this.discardZoneGfx) return;
      this.discardZoneGfx.clear();
      this.discardZoneGfx.lineStyle(2, 0x0d5a43, 0.35);
      this.discardZoneGfx.strokeRoundedRect(c.x - zw / 2, c.y - zh / 2, zw, zh, 14);

      const label = scene.add.text(c.x - 50, c.y - zh / 2 - 18, 'DISCARD', { fontSize: '12px' });
      this.discardsLayer?.add(label);
    }

    private drawDiscards(pub: PublicSnapshot): void {
      const { x: cx, y: cy } = this.centerPoint();
      const tiles = pub.discards ?? [];
      if (!tiles.length) return;

      const cols = 8;
      const { w: tw, h: th } = this.tileStyle;
      const gap = 6;

      const gridW = cols * tw + (cols - 1) * gap;
      const startX = Math.floor(cx - gridW / 2);
      const startY = Math.floor(cy - 60);

      for (let i = 0; i < tiles.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = startX + col * (tw + gap);
        const y = startY + row * (th + gap);

        const tileObj = this.makeTile(x, y, tiles[i], { interactive: false });
        this.discardsLayer?.add(tileObj);
      }
    }

    // ------------------------
    // Exposures
    // ------------------------
    private drawExposures(pub: PublicSnapshot): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      const exposures = pub.exposures ?? [];
      if (!exposures.length) return;

      const { w: tw, h: th } = this.tileStyle;
      const gap = 6;

      const anchor = (seatIndex: number): { x: number; y: number; dir: 'h' | 'v' } => {
        switch (seatIndex) {
          case 0: return { x: 16, y: h - th * 3 - 160, dir: 'h' };
          case 1: return { x: w - tw - 16, y: Math.floor(h * 0.30), dir: 'v' };
          case 2: return { x: 16, y: 90, dir: 'h' };
          case 3: return { x: 16, y: Math.floor(h * 0.30), dir: 'v' };
          default: return { x: 16, y: 90, dir: 'h' };
        }
      };

      for (const seatExp of exposures) {
        const a = anchor(seatExp.seatIndex);
        let cursorX = a.x;
        let cursorY = a.y;

        for (const meld of seatExp.melds) {
          const label = scene.add.text(cursorX, cursorY - 18, `${meld.kind}`, { fontSize: '12px' });
          this.exposuresLayer?.add(label);

          for (let i = 0; i < meld.tiles.length; i++) {
            const t = meld.tiles[i];
            const tx = a.dir === 'h' ? cursorX + i * (tw + gap) : cursorX;
            const ty = a.dir === 'h' ? cursorY : cursorY + i * (th + gap);
            this.exposuresLayer?.add(this.makeTile(tx, ty, t, { interactive: false }));
          }

          if (a.dir === 'h') cursorX += meld.tiles.length * (tw + gap) + 18;
          else cursorY += meld.tiles.length * (th + gap) + 24;
        }
      }
    }

    // ------------------------
    // Hand (persistent + reorder + double click discard)
    // ------------------------
    private syncAndDrawHand(pub: PublicSnapshot, priv: PrivateSnapshot): void {
      const scene = this as unknown as Phaser.Scene;

      const hand = priv.hand ?? [];
      const { keys, keyToTileId } = makeHandKeys(hand);
      this.keyToTileId = keyToTileId;

      // reconcile local order:
      // - keep existing keys in same order if still present
      // - append newly appeared keys at end
      const setNow = new Set(keys);

      if (!this.handOrder.length) {
        this.handOrder = [...keys];
      } else {
        const kept = this.handOrder.filter((k) => setNow.has(k));
        const missing = keys.filter((k) => !kept.includes(k));
        this.handOrder = [...kept, ...missing];
      }

      // create missing game objects
      for (const k of this.handOrder) {
        if (this.handTiles.has(k)) continue;
        const tileId = this.keyToTileId.get(k) ?? '??';
        const go = this.createHandTileGO(k, tileId);
        this.handTiles.set(k, go);
        this.handLayer?.add(go);
      }

      // remove deleted tiles
      for (const [k, go] of Array.from(this.handTiles.entries())) {
        if (setNow.has(k)) continue;
        go.destroy?.(true);
        this.handTiles.delete(k);
      }

      // update labels (in case key->tileId changed due to occurrence remap)
      for (const [k, go] of this.handTiles.entries()) {
        const tileId = this.keyToTileId.get(k) ?? '??';
        const txt = go?.getData?.('labelText');
        if (txt?.setText) txt.setText(formatTileLabel(tileId));
      }

      // position them to slots
      this.snapAllHandTiles(false);

      // update “discard allowed” visual hint
      const canDiscard =
        pub.phase === 'playing' &&
        (pub as any).turnStage === 'NEED_DISCARD' &&
        priv.seatIndex === pub.currentTurnSeat;

      for (const [k, go] of this.handTiles.entries()) {
        const tileId = this.keyToTileId.get(k) ?? '??';
        go.setData?.('tileId', tileId);
        go.setData?.('canDiscard', canDiscard);
        // subtle alpha hint only; still draggable for reorder
        go.setAlpha?.(1.0);
      }

      // store hand len for animations
      void scene;
    }

    private handSlots(): Array<{ x: number; y: number }> {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      const { w: tw, h: th } = this.tileStyle;
      const gap = 10;

      const count = this.handOrder.length;
      if (!count) return [];

      const rowCap = Math.max(10, Math.min(16, count));
      const cols = Math.min(rowCap, count);

      const gridW = cols * tw + (cols - 1) * gap;
      const startX = Math.floor((w - gridW) / 2);
      const startY = h - th - 26;

      const slots: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < count; i++) {
        const col = i % rowCap;
        const row = Math.floor(i / rowCap);
        const x = startX + col * (tw + gap);
        const y = startY - row * (th + gap);
        slots.push({ x, y });
      }
      return slots;
    }

    private snapAllHandTiles(animate: boolean): void {
      const scene = this as unknown as Phaser.Scene;
      const slots = this.handSlots();

      for (let i = 0; i < this.handOrder.length; i++) {
        const k = this.handOrder[i];
        const go = this.handTiles.get(k);
        const s = slots[i];
        if (!go || !s) continue;

        // store slot for snap-back
        go.setData?.('slotX', s.x);
        go.setData?.('slotY', s.y);
        go.setDepth?.(100 + i);

        if (!animate) {
          go.x = s.x;
          go.y = s.y;
          go.alpha = 1.0;
        } else {
          scene.tweens.add({ targets: go, x: s.x, y: s.y, duration: 90 });
        }
      }
    }

    private snapTileToSlot(key: string, animate: boolean): void {
      const scene = this as unknown as Phaser.Scene;
      const go = this.handTiles.get(key);
      if (!go) return;
      const x = go.getData?.('slotX');
      const y = go.getData?.('slotY');
      if (typeof x !== 'number' || typeof y !== 'number') return;

      if (!animate) {
        go.x = x;
        go.y = y;
        go.alpha = 1.0;
      } else {
        scene.tweens.add({ targets: go, x, y, alpha: 1.0, duration: 110 });
      }
    }

    private previewReorder(key: string, dragX: number, dragY: number): void {
      // If dragging near rack area, reorder based on closest slot
      const slots = this.handSlots();
      if (!slots.length) return;

      // only reorder if pointer is in lower half of screen (rack region)
      const scene = this as unknown as Phaser.Scene;
      const h = scene.scale.height;
      if (dragY < h * 0.45) return;

      let best = -1;
      let bestD = Number.POSITIVE_INFINITY;
      for (let i = 0; i < slots.length; i++) {
        const dx = dragX - slots[i].x;
        const dy = dragY - slots[i].y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) return;

      const cur = this.handOrder.indexOf(key);
      if (cur < 0 || cur === best) return;

      // move key to best index
      this.handOrder.splice(cur, 1);
      this.handOrder.splice(best, 0, key);

      // snap others (not the dragged one) to their new slots
      const dragged = this.handTiles.get(key);
      const scene2 = this as unknown as Phaser.Scene;

      const newSlots = this.handSlots();
      for (let i = 0; i < this.handOrder.length; i++) {
        const k = this.handOrder[i];
        const go = this.handTiles.get(k);
        const s = newSlots[i];
        if (!go || !s) continue;

        go.setData?.('slotX', s.x);
        go.setData?.('slotY', s.y);

        if (go === dragged) continue; // user controls it
        scene2.tweens.add({ targets: go, x: s.x, y: s.y, duration: 60 });
      }
    }

    private createHandTileGO(key: string, tileId: string): any {
      const scene = this as unknown as Phaser.Scene;
      const { w, h, r, fontSize } = this.tileStyle;

      const c = scene.add.container(0, 0);

      const g = scene.add.graphics();
      g.fillStyle(0xf2efe6, 1);
      g.fillRoundedRect(0, 0, w, h, r);
      g.lineStyle(2, 0x2b2b2b, 1);
      g.strokeRoundedRect(0, 0, w, h, r);

      const txt = scene.add.text(6, 6, formatTileLabel(tileId), {
        fontSize: `${fontSize}px`,
        color: '#111',
        wordWrap: { width: w - 12 },
      });

      c.add([g, txt]);

      // full-tile hit area + cursor
      // Phaser supports useHandCursor on interactive objects. :contentReference[oaicite:6]{index=6}
      c.setSize?.(w, h);
      c.setInteractive?.(
        new PhaserNS.Geom.Rectangle(0, 0, w, h),
        PhaserNS.Geom.Rectangle.Contains,
      );
      if (c.input) c.input.cursor = 'pointer'; // force cursor on hover (more reliable than defaults)

      // make draggable always (for reorder)
      (scene.input as any).setDraggable(c, true);

      // metadata
      c.setData?.('isHandTile', true);
      c.setData?.('handKey', key);
      c.setData?.('labelText', txt);

      // double click discard (only if allowed)
      c.on?.('pointerup', (pointer: any) => {
        // ignore if this pointerup was end of drag
        if (this.isDraggingHand) return;

        const now = Date.now();
        const sameKey = this.lastClickKey === key;
        const within = now - this.lastClickAt <= 280;

        this.lastClickAt = now;
        this.lastClickKey = key;

        if (!(sameKey && within)) return; // not a double click

        const pub = this.publicSnap;
        const priv = this.privateSnap;
        if (!pub || !priv) return;

        const canDiscard =
          pub.phase === 'playing' &&
          (pub as any).turnStage === 'NEED_DISCARD' &&
          priv.seatIndex === pub.currentTurnSeat;

        if (!canDiscard) return;

        const tileId2 = this.keyToTileId.get(key);
        if (!tileId2) return;

        const idx = this.handOrder.indexOf(key);
        bridge?.onHandTileClick?.(tileId2, idx);

        // tiny feedback
        scene.tweens.add({ targets: c, alpha: 0.35, duration: 70, yoyo: true });
        void pointer;
      });

      return c;
    }

    // ------------------------
    // Claim banner
    // ------------------------
    private drawClaimBanner(tileId: string, fromSeat: number): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;

      const c = scene.add.container(0, 0);
      const g = scene.add.graphics();
      g.fillStyle(0x000000, 0.35);
      g.fillRect(0, 44, w, 28);

      const t = scene.add.text(16, 48, `CLAIM: ${formatTileLabel(tileId)} (from seat ${fromSeat})`, {
        fontSize: '14px',
      });

      c.add([g, t]);
      this.hudLayer?.add(c);
      this.claimBar = c;
    }

    // ------------------------
    // Generic tile factory (non-hand tiles)
    // ------------------------
    private makeTile(
      x: number,
      y: number,
      tileId: string,
      opts: { interactive: boolean },
    ): any {
      const scene = this as unknown as Phaser.Scene;
      const { w, h, r, fontSize } = this.tileStyle;

      const c = scene.add.container(x, y);

      const g = scene.add.graphics();
      g.fillStyle(0xf2efe6, 1);
      g.fillRoundedRect(0, 0, w, h, r);
      g.lineStyle(2, 0x2b2b2b, 1);
      g.strokeRoundedRect(0, 0, w, h, r);

      const txt = scene.add.text(6, 6, formatTileLabel(tileId), {
        fontSize: `${fontSize}px`,
        color: '#111',
        wordWrap: { width: w - 12 },
      });

      c.add([g, txt]);

      if (opts.interactive) {
        c.setSize?.(w, h);
        c.setInteractive?.(new PhaserNS.Geom.Rectangle(0, 0, w, h), PhaserNS.Geom.Rectangle.Contains);
        if (c.input) c.input.cursor = 'pointer';
      }

      return c;
    }
  };
}

/* import type Phaser from 'phaser';
import type { PublicSnapshot, PrivateSnapshot } from '../core/socket.service';

export interface TableSceneBridge {
  onHandTileClick?: (tileId: string, handIndex: number) => void;
  onPickClick?: () => void;
}

export interface TileStyle {
  w: number;
  h: number;
  r: number;
  fontSize: number;
}

interface SeatAnchor {
  x: number;
  y: number;
  dir: 'h' | 'v';
  align: 'start' | 'center' | 'end';
}

interface DropPayload {
  tileId: string;
  handIndex: number;
  homeX: number;
  homeY: number;
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function formatTileLabel(id: string): string {
  // Keep transport ids short (B7, D5, C9, DR/DG/DW, F, J) for performance.
  // UI can prettify a bit without changing server logic.
  if (id === 'J' || id === 'JOKER') return 'JOKER';
  if (id === 'F') return 'FLOWER';
  if (id === 'DR') return 'DRAGON R';
  if (id === 'DG') return 'DRAGON G';
  if (id === 'DW' || id === 'WE' || id === 'WW') return 'DRAGON W';

  // B7 / D5 / C9 style
  const m = /^([BDC])(\d+)$/.exec(id);
  if (!m) return id;
  const suit = m[1] === 'B' ? 'BAM' : m[1] === 'D' ? 'DOT' : 'CRAK';
  return `${suit} ${m[2]}`;
}

export function createTableScene(PhaserNS: any, bridge?: TableSceneBridge) {
  const SceneBase = PhaserNS.Scene;

  return class TableScene extends SceneBase {
    private publicSnap: PublicSnapshot | null = null;
    private privateSnap: PrivateSnapshot | null = null;
    private created = false;

    private tileStyle: TileStyle = { w: 56, h: 76, r: 10, fontSize: 12 };

    // layers
    private bgLayer?: any;
    private seatsLayer?: any;
    private exposuresLayer?: any;
    private discardsLayer?: any;
    private handLayer?: any;
    private hudLayer?: any;

    // persistent objects
    private felt?: any;
    private infoText?: any;
    private claimBar?: any;

    // wall ui
    private wallBox?: any;
    private wallText?: any;

    // discard drop zone
    private discardZone?: any;
    private discardZoneGfx?: any;

    // simple diff memory (for light animation decisions)
    private prevHandLen = 0;
    private prevDiscardLen = 0;
    private prevPhase: string | null = null;

    constructor() {
      super('table');
    }

    create(): void {
      const scene = this as unknown as Phaser.Scene;
      this.created = true;

      // layers in order
      this.bgLayer = scene.add.container(0, 0);
      this.seatsLayer = scene.add.container(0, 0);
      this.exposuresLayer = scene.add.container(0, 0);
      this.discardsLayer = scene.add.container(0, 0);
      this.handLayer = scene.add.container(0, 0);
      this.hudLayer = scene.add.container(0, 0);

      // felt
      this.felt = scene.add.graphics();
      this.bgLayer.add(this.felt);

      // HUD
      this.infoText = scene.add.text(16, 12, 'Waiting…', { fontSize: '14px' });
      this.hudLayer.add(this.infoText);

      // Create discard drop zone ONCE
      this.discardZone = scene.add.zone(0, 0, 10, 10).setRectangleDropZone(10, 10);
      this.discardZoneGfx = scene.add.graphics();
      this.discardsLayer.add(this.discardZoneGfx);

      // Drag/drop events (register ONCE)
      scene.input.on('dragstart', (_p: any, go: any) => {
        go.setDepth?.(999);
        scene.tweens.add({ targets: go, scaleX: 1.04, scaleY: 1.04, duration: 80 });
      });

      scene.input.on('drag', (_p: any, go: any, dragX: number, dragY: number) => {
        go.x = dragX;
        go.y = dragY;
      });

      scene.input.on('drop', (_p: any, go: any, _dz: any) => {
        const payload: DropPayload | undefined = (go.getData && go.getData('payload')) as
          | DropPayload
          | undefined;
        if (!payload) return;

        // trigger discard via bridge
        bridge?.onHandTileClick?.(payload.tileId, payload.handIndex);

        // animate to center quickly (feels good, even if server rejects later)
        scene.tweens.add({
          targets: go,
          x: this.centerPoint().x,
          y: this.centerPoint().y,
          alpha: 0.0,
          duration: 140,
          onComplete: () => {
            // server snapshot will redraw anyway
          },
        });
      });

      scene.input.on('dragend', (_p: any, go: any, dropped: boolean) => {
        const payload: DropPayload | undefined = (go.getData && go.getData('payload')) as
          | DropPayload
          | undefined;
        if (!payload) return;

        if (!dropped) {
          // snap back
          scene.tweens.add({
            targets: go,
            x: payload.homeX,
            y: payload.homeY,
            scaleX: 1,
            scaleY: 1,
            duration: 120,
          });
        } else {
          scene.tweens.add({ targets: go, scaleX: 1, scaleY: 1, duration: 80 });
        }
      });

      // Resize
      scene.scale.on(
        PhaserNS.Scale.Events.RESIZE,
        () => {
          this.layout();
          this.redrawFelt();
          this.renderAll();
        },
        this,
      );

      this.layout();
      this.redrawFelt();
      this.renderAll(); // if snapshots already arrived
    }

    setSnapshots(pub: PublicSnapshot | null, priv: PrivateSnapshot | null): void {
      this.publicSnap = pub;
      this.privateSnap = priv;

      if (!this.created) return;
      this.renderAll();
    }

    // ------------------------
    // Layout + background
    // ------------------------
    private layout(): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;

      const base = Math.max(44, Math.min(66, Math.floor(w / 18)));
      this.tileStyle = {
        w: base,
        h: Math.floor(base * 1.35),
        r: Math.floor(base * 0.18),
        fontSize: clamp(Math.floor(base / 4), 10, 14),
      };

      if (this.infoText) this.infoText.setPosition(16, 12);
      this.layoutWall();
      this.layoutDiscardZone();
    }

    private redrawFelt(): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      if (!this.felt) return;

      this.felt.clear();
      this.felt.fillStyle(0x0b3d2e, 1);
      this.felt.fillRect(0, 0, w, h);

      this.felt.lineStyle(2, 0x083226, 1);
      this.felt.strokeRect(8, 8, w - 16, h - 16);
    }

    private centerPoint(): { x: number; y: number } {
      const scene = this as unknown as Phaser.Scene;
      return { x: Math.floor(scene.scale.width / 2), y: Math.floor(scene.scale.height / 2) };
    }

    // ------------------------
    // Render
    // ------------------------
    private renderAll(): void {
      if (!this.created) return;

      const scene = this as unknown as Phaser.Scene;
      const pub = this.publicSnap;
      const priv = this.privateSnap;

      if (!this.seatsLayer || !this.exposuresLayer || !this.discardsLayer || !this.handLayer || !this.hudLayer) {
        return;
      }

      // Clear re-render layers
      this.seatsLayer.removeAll(true);
      this.exposuresLayer.removeAll(true);
      this.discardsLayer.removeAll(true);
      this.handLayer.removeAll(true);

      // claim banner reset
      if (this.claimBar) {
        this.claimBar.destroy(true);
        this.claimBar = undefined;
      }

      // HUD
      if (this.infoText && pub) {
        this.infoText.setText(
          `Room: ${pub.roomId} | Phase: ${pub.phase} | Turn: ${pub.currentTurnSeat} | Wall: ${pub.wallCount} | v${pub.version}`,
        );
      } else if (this.infoText) {
        this.infoText.setText('Waiting…');
      }

      // Wall
      if (pub) this.drawWall(pub, priv);

      // Seats (other racks)
      if (pub && priv) this.drawOtherRacks(pub, priv);

      // Discards + exposures
      if (pub) {
        this.drawDiscardZoneVisual();
        this.drawDiscards(pub);
        this.drawExposures(pub);
      }

      // Hand
      if (pub && priv) this.drawHand(pub, priv);

      // Claim banner: show only if you can act (not the discarder)
      if (pub?.phase === 'claim' && pub.claim && priv) {
        if (priv.seatIndex !== pub.claim.fromSeat) {
          this.drawClaimBanner(pub.claim.tileId, pub.claim.fromSeat);
        }
      }

      // lightweight “something changed” animations
      this.applyLightAnimations(pub, priv);

      // store diffs
      this.prevHandLen = priv?.hand?.length ?? 0;
      this.prevDiscardLen = pub?.discards?.length ?? 0;
      this.prevPhase = pub?.phase ?? null;

      scene.input?.setDefaultCursor('default');
    }

    private applyLightAnimations(pub: PublicSnapshot | null, priv: PrivateSnapshot | null): void {
      const scene = this as unknown as Phaser.Scene;
      if (!pub || !priv) return;

      // Hand gained (pick) feel: flash wall briefly
      const handLen = priv.hand?.length ?? 0;
      if (handLen > this.prevHandLen && this.wallBox) {
        scene.tweens.add({ targets: this.wallBox, alpha: 0.4, duration: 70, yoyo: true, repeat: 2 });
      }

      // Discard added feel: pulse discard zone border
      const discLen = pub.discards?.length ?? 0;
      if (discLen > this.prevDiscardLen && this.discardZoneGfx) {
        scene.tweens.add({ targets: this.discardZoneGfx, alpha: 0.35, duration: 90, yoyo: true, repeat: 2 });
      }

      // Phase changed: quick HUD pulse
      if (this.prevPhase && pub.phase !== this.prevPhase && this.infoText) {
        scene.tweens.add({ targets: this.infoText, alpha: 0.4, duration: 80, yoyo: true, repeat: 2 });
      }
    }

    // ------------------------
    // Wall (top-right)
    // ------------------------
    private layoutWall(): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;

      const boxW = 120;
      const boxH = 54;

      if (!this.wallBox) {
        this.wallBox = scene.add.container(0, 0);
        const g = scene.add.graphics();
        g.fillStyle(0x06261c, 0.9);
        g.fillRoundedRect(0, 0, boxW, boxH, 10);
        g.lineStyle(2, 0x0d5a43, 1);
        g.strokeRoundedRect(0, 0, boxW, boxH, 10);
        this.wallText = scene.add.text(10, 10, 'Wall: -', { fontSize: '14px' });
        this.wallBox.add([g, this.wallText]);

        // interactive hit
        const hit = scene.add.rectangle(boxW / 2, boxH / 2, boxW, boxH, 0x000000, 0);
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => bridge?.onPickClick?.());
        this.wallBox.add(hit);

        this.hudLayer?.add(this.wallBox);
      }

      this.wallBox.setPosition(w - boxW - 16, 12);
      this.wallBox.setAlpha(1);
    }

    private drawWall(pub: PublicSnapshot, priv: PrivateSnapshot | null): void {
      if (!this.wallText || !this.wallBox) return;

      this.wallText.setText(`Wall: ${pub.wallCount}`);

      // visually “disabled” unless it’s your turn and NEED_PICK
      const canPick =
        !!priv &&
        pub.phase === 'playing' &&
        (pub as any).turnStage === 'NEED_PICK' &&
        priv.seatIndex === pub.currentTurnSeat;

      this.wallBox.setAlpha(canPick ? 1.0 : 0.55);
    }

    // ------------------------
    // Opponent racks (tile backs)
    // ------------------------
    private drawOtherRacks(pub: PublicSnapshot, priv: PrivateSnapshot): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      // We only know our own hand. For others, show generic “rack backs”.
      // You can later include handCount per seat in PublicSnapshot to make it accurate.
      const backCount = 13;

      const mySeat = priv.seatIndex;
      for (let seat = 0; seat < 4; seat++) {
        if (seat === mySeat) continue;

        const a = this.seatAnchor(seat, w, h);
        const g = scene.add.graphics();
        g.fillStyle(0x152a24, 0.7);

        if (a.dir === 'h') {
          g.fillRoundedRect(a.x, a.y, 320, 34, 10);
        } else {
          g.fillRoundedRect(a.x, a.y, 34, 320, 10);
        }

        const txt = scene.add.text(
          a.x + (a.dir === 'h' ? 10 : 42),
          a.y + (a.dir === 'h' ? 8 : 10),
          `Seat ${seat} | Tiles ~${backCount}${seat === pub.currentTurnSeat ? ' (TURN)' : ''}`,
          { fontSize: '12px' },
        );

        this.seatsLayer?.add(g);
        this.seatsLayer?.add(txt);
      }
    }

    private seatAnchor(seatIndex: number, w: number, h: number): SeatAnchor {
      // Absolute anchors, not relative-to-player (MVP)
      // seat 0 bottom, 1 right, 2 top, 3 left
      if (seatIndex === 0) return { x: Math.floor(w / 2) - 160, y: h - 120, dir: 'h', align: 'center' };
      if (seatIndex === 1) return { x: w - 70, y: Math.floor(h / 2) - 160, dir: 'v', align: 'center' };
      if (seatIndex === 2) return { x: Math.floor(w / 2) - 160, y: 70, dir: 'h', align: 'center' };
      return { x: 36, y: Math.floor(h / 2) - 160, dir: 'v', align: 'center' };
    }

    // ------------------------
    // Discard zone visual (center)
    // ------------------------
    private layoutDiscardZone(): void {
      const scene = this as unknown as Phaser.Scene;
      const c = this.centerPoint();

      const zw = 260;
      const zh = 160;

      if (this.discardZone) {
        this.discardZone.x = c.x;
        this.discardZone.y = c.y;
        this.discardZone.setSize(zw, zh);
        this.discardZone.input?.hitArea?.setSize?.(zw, zh);
      }
    }

    private drawDiscardZoneVisual(): void {
      const scene = this as unknown as Phaser.Scene;
      const c = this.centerPoint();
      const zw = 260;
      const zh = 160;

      if (!this.discardZoneGfx) return;
      this.discardZoneGfx.clear();
      this.discardZoneGfx.lineStyle(2, 0x0d5a43, 0.35);
      this.discardZoneGfx.strokeRoundedRect(c.x - zw / 2, c.y - zh / 2, zw, zh, 14);

      const label = scene.add.text(c.x - 50, c.y - zh / 2 - 18, 'DISCARD', { fontSize: '12px' });
      this.discardsLayer?.add(label);
    }

    // ------------------------
    // Discards pile (center grid)
    // ------------------------
    private drawDiscards(pub: PublicSnapshot): void {
      const scene = this as unknown as Phaser.Scene;
      const { x: cx, y: cy } = this.centerPoint();

      const tiles = pub.discards ?? [];
      if (!tiles.length) return;

      const cols = 8;
      const { w: tw, h: th } = this.tileStyle;
      const gap = 6;

      const gridW = cols * tw + (cols - 1) * gap;
      const startX = Math.floor(cx - gridW / 2);
      const startY = Math.floor(cy - 60);

      for (let i = 0; i < tiles.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = startX + col * (tw + gap);
        const y = startY + row * (th + gap);

        const tileObj = this.makeTile(x, y, tiles[i], { clickable: false });
        this.discardsLayer?.add(tileObj);
      }
    }

    // ------------------------
    // Exposures
    // ------------------------
    private drawExposures(pub: PublicSnapshot): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      const exposures = pub.exposures ?? [];
      if (!exposures.length) return;

      const { w: tw, h: th } = this.tileStyle;
      const gap = 6;

      const anchor = (seatIndex: number): { x: number; y: number; dir: 'h' | 'v' } => {
        switch (seatIndex) {
          case 0: return { x: 16, y: h - th * 3 - 160, dir: 'h' };
          case 1: return { x: w - tw - 16, y: Math.floor(h * 0.30), dir: 'v' };
          case 2: return { x: 16, y: 90, dir: 'h' };
          case 3: return { x: 16, y: Math.floor(h * 0.30), dir: 'v' };
          default: return { x: 16, y: 90, dir: 'h' };
        }
      };

      for (const seatExp of exposures) {
        const a = anchor(seatExp.seatIndex);
        let cursorX = a.x;
        let cursorY = a.y;

        for (const meld of seatExp.melds) {
          const label = scene.add.text(cursorX, cursorY - 18, `${meld.kind}`, { fontSize: '12px' });
          this.exposuresLayer?.add(label);

          for (let i = 0; i < meld.tiles.length; i++) {
            const t = meld.tiles[i];
            const tx = a.dir === 'h' ? cursorX + i * (tw + gap) : cursorX;
            const ty = a.dir === 'h' ? cursorY : cursorY + i * (th + gap);
            this.exposuresLayer?.add(this.makeTile(tx, ty, t, { clickable: false }));
          }

          if (a.dir === 'h') cursorX += meld.tiles.length * (tw + gap) + 18;
          else cursorY += meld.tiles.length * (th + gap) + 24;
        }
      }
    }

    // ------------------------
    // Hand (bottom, draggable to discard)
    // ------------------------
    private drawHand(pub: PublicSnapshot, priv: PrivateSnapshot): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      const hand = priv.hand ?? [];
      if (!hand.length) return;

      const { w: tw, h: th } = this.tileStyle;
      const gap = 10;

      const rowCap = Math.max(10, Math.min(16, hand.length));
      const cols = Math.min(rowCap, hand.length);

      const gridW = cols * tw + (cols - 1) * gap;
      const startX = Math.floor((w - gridW) / 2);
      const startY = h - th - 26;

      const canDiscard =
        pub.phase === 'playing' &&
        (pub as any).turnStage === 'NEED_DISCARD' &&
        priv.seatIndex === pub.currentTurnSeat;

      for (let i = 0; i < hand.length; i++) {
        const col = i % rowCap;
        const row = Math.floor(i / rowCap);

        const x = startX + col * (tw + gap);
        const y = startY - row * (th + gap);

        const tileId = hand[i];
        const tileObj = this.makeTile(x, y, tileId, {
          clickable: canDiscard,
          onClick: () => bridge?.onHandTileClick?.(tileId, i),
        });

        // attach drag payload
        if (canDiscard) {
          tileObj.setSize?.(tw, th);
          tileObj.setInteractive?.(new PhaserNS.Geom.Rectangle(0, 0, tw, th), PhaserNS.Geom.Rectangle.Contains);
          scene.input.setDraggable(tileObj);

          const payload: DropPayload = { tileId, handIndex: i, homeX: x, homeY: y };
          tileObj.setData?.('payload', payload);
        }

        this.handLayer?.add(tileObj);
      }
    }

    // ------------------------
    // Claim banner
    // ------------------------
    private drawClaimBanner(tileId: string, fromSeat: number): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;

      const c = scene.add.container(0, 0);
      const g = scene.add.graphics();
      g.fillStyle(0x000000, 0.35);
      g.fillRect(0, 44, w, 28);

      const t = scene.add.text(16, 48, `CLAIM: ${formatTileLabel(tileId)} (from seat ${fromSeat})`, {
        fontSize: '14px',
      });

      c.add([g, t]);
      this.hudLayer?.add(c);
      this.claimBar = c;
    }

    // ------------------------
    // Tile factory
    // ------------------------
    private makeTile(
      x: number,
      y: number,
      tileId: string,
      opts: { clickable: boolean; onClick?: () => void },
    ): any {
      const scene = this as unknown as Phaser.Scene;
      const { w, h, r, fontSize } = this.tileStyle;

      const c = scene.add.container(x, y);

      const g = scene.add.graphics();
      g.fillStyle(0xf2efe6, 1);
      g.fillRoundedRect(0, 0, w, h, r);
      g.lineStyle(2, 0x2b2b2b, 1);
      g.strokeRoundedRect(0, 0, w, h, r);

      const txt = scene.add.text(6, 6, formatTileLabel(tileId), {
        fontSize: `${fontSize}px`,
        color: '#111',
        wordWrap: { width: w - 12 },
      });

      c.add([g, txt]);

      if (opts.clickable) {
        const hit = scene.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0);
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => opts.onClick?.());
        c.add(hit);
      }

      return c;
    }
  };
} */

/* import type Phaser from 'phaser';
import type { PublicSnapshot, PrivateSnapshot } from '../core/socket.service';

export interface TableSceneBridge {
  onHandTileClick?: (tileId: string, handIndex: number) => void;
}

interface TileStyle {
  w: number;
  h: number;
  r: number;
  fontSize: number;
}

export function createTableScene(PhaserNS: any, bridge?: TableSceneBridge) {
  const SceneBase = PhaserNS.Scene;

  return class TableScene extends SceneBase {
    private publicSnap: PublicSnapshot | null = null;
    private privateSnap: PrivateSnapshot | null = null;

    private created = false;

    // layers (in render order)
    private bgLayer?: any;
    private exposuresLayer?: any;
    private discardsLayer?: any;
    private handLayer?: any;
    private hudLayer?: any;

    // persistent objects
    private felt?: any;
    private infoText?: any;
    private claimBar?: any;

    private tileStyle: TileStyle = { w: 56, h: 76, r: 10, fontSize: 12 };

    constructor() {
      super('table');
    }

    create(): void {
      const scene = this as unknown as Phaser.Scene;
      this.created = true;

      // Create layers in correct order:
      // background -> exposures -> discards -> hand -> HUD
      this.bgLayer = scene.add.container(0, 0);
      this.exposuresLayer = scene.add.container(0, 0);
      this.discardsLayer = scene.add.container(0, 0);
      this.handLayer = scene.add.container(0, 0);
      this.hudLayer = scene.add.container(0, 0);

      // Create felt ONCE (so it doesn't cover everything every render)
      this.felt = scene.add.graphics();
      this.bgLayer.add(this.felt);

      // HUD
      this.infoText = scene.add.text(16, 12, 'Waiting…', { fontSize: '14px' });
      this.hudLayer.add(this.infoText);

      // Resize handling
      scene.scale.on(
        PhaserNS.Scale.Events.RESIZE,
        () => {
          this.layout();
          this.redrawFelt();
          this.renderAll();
        },
        this,
      );

      this.layout();
      this.redrawFelt();
      this.renderAll(); // if snapshots came before create()
    }

    setSnapshots(pub: PublicSnapshot | null, priv: PrivateSnapshot | null): void {
      this.publicSnap = pub;
      this.privateSnap = priv;

      if (!this.created) return;
      this.renderAll();
    }

    // ------------------------
    // Layout + background
    // ------------------------
    private layout(): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;

      const base = Math.max(44, Math.min(62, Math.floor(w / 18)));
      this.tileStyle = {
        w: base,
        h: Math.floor(base * 1.35),
        r: Math.floor(base * 0.18),
        fontSize: Math.max(10, Math.min(14, Math.floor(base / 4))),
      };

      if (this.infoText) this.infoText.setPosition(16, 12);
    }

    private redrawFelt(): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      if (!this.felt) return;

      this.felt.clear();
      this.felt.fillStyle(0x0b3d2e, 1);
      this.felt.fillRect(0, 0, w, h);

      this.felt.lineStyle(2, 0x083226, 1);
      this.felt.strokeRect(8, 8, w - 16, h - 16);
    }

    // ------------------------
    // Render
    // ------------------------
    private renderAll(): void {
      if (!this.created) return;

      const scene = this as unknown as Phaser.Scene;
      const pub = this.publicSnap;
      const priv = this.privateSnap;

      if (!this.exposuresLayer || !this.discardsLayer || !this.handLayer || !this.hudLayer) return;

      // Clear layers that re-render (NOT background felt)
      // Container.removeAll(true) destroys children. :contentReference[oaicite:2]{index=2}
      this.exposuresLayer.removeAll(true);
      this.discardsLayer.removeAll(true);
      this.handLayer.removeAll(true);

      // Clear claim banner if any
      if (this.claimBar) {
        this.claimBar.destroy(true);
        this.claimBar = undefined;
      }

      // HUD text
      if (this.infoText && pub) {
        const phase = pub.phase ?? 'lobby';
        this.infoText.setText(
          `Room: ${pub.roomId} | Phase: ${phase} | Turn: ${pub.currentTurnSeat} | Wall: ${pub.wallCount} | v${pub.version}`,
        );
      } else if (this.infoText) {
        this.infoText.setText('Waiting…');
      }

      // Draw public stuff
      if (pub) {
        this.drawDiscards(pub);
        this.drawExposures(pub);
      }

      // Draw private hand
      if (pub && priv) {
        this.drawHand(pub, priv);
      }

      // Claim banner: show ONLY if you can act (not the discarder)
      if (pub?.phase === 'claim' && pub.claim && priv) {
        if (priv.seatIndex !== pub.claim.fromSeat) {
          this.drawClaimBanner(pub.claim.tileId, pub.claim.fromSeat);
        }
      }

      // FYI: Phaser renders objects in display list order by default. :contentReference[oaicite:3]{index=3}
      // We keep felt in bgLayer so it never covers tiles.
      scene.input?.setDefaultCursor('default');
    }

    // ------------------------
    // Discards (center)
    // ------------------------
    private drawDiscards(pub: PublicSnapshot): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      const tiles = pub.discards ?? [];
      if (!tiles.length) return;

      const cols = 12;
      const { w: tw, h: th } = this.tileStyle;
      const gap = 6;

      const gridW = cols * tw + (cols - 1) * gap;
      const startX = Math.floor((w - gridW) / 2);
      const startY = Math.floor(h * 0.35);

      for (let i = 0; i < tiles.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);

        const x = startX + col * (tw + gap);
        const y = startY + row * (th + gap);

        const tileObj = this.makeTile(x, y, tiles[i], { clickable: false });
        this.discardsLayer.add(tileObj);
      }
    }

    // ------------------------
    // Exposures (if provided by server)
    // ------------------------
    private drawExposures(pub: PublicSnapshot): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      const exposures = (pub as any).exposures as
        | Array<{ seatIndex: number; melds: Array<{ kind: string; tiles: string[] }> }>
        | undefined;

      if (!exposures?.length) return;

      const { w: tw, h: th } = this.tileStyle;
      const gap = 6;

      const anchor = (seatIndex: number): { x: number; y: number; dir: 'h' | 'v' } => {
        switch (seatIndex) {
          case 0: return { x: 16, y: h - th * 3 - 140, dir: 'h' };
          case 1: return { x: w - tw - 16, y: Math.floor(h * 0.30), dir: 'v' };
          case 2: return { x: 16, y: 70, dir: 'h' };
          case 3: return { x: 16, y: Math.floor(h * 0.30), dir: 'v' };
          default: return { x: 16, y: 70, dir: 'h' };
        }
      };

      for (const seatExp of exposures) {
        const a = anchor(seatExp.seatIndex);
        let cursorX = a.x;
        let cursorY = a.y;

        for (const meld of seatExp.melds) {
          const label = scene.add.text(cursorX, cursorY - 18, `${meld.kind}`, { fontSize: '12px' });
          this.exposuresLayer.add(label);

          for (let i = 0; i < meld.tiles.length; i++) {
            const t = meld.tiles[i];
            const tx = a.dir === 'h' ? cursorX + i * (tw + gap) : cursorX;
            const ty = a.dir === 'h' ? cursorY : cursorY + i * (th + gap);
            this.exposuresLayer.add(this.makeTile(tx, ty, t, { clickable: false }));
          }

          if (a.dir === 'h') cursorX += meld.tiles.length * (tw + gap) + 18;
          else cursorY += meld.tiles.length * (th + gap) + 24;
        }
      }
    }

    // ------------------------
    // Hand (bottom)
    // ------------------------
    private drawHand(pub: PublicSnapshot, priv: PrivateSnapshot): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;
      const h = scene.scale.height;

      const hand = priv.hand ?? [];
      if (!hand.length) return;

      const { w: tw, h: th } = this.tileStyle;
      const gap = 8;

      const rowCap = Math.max(8, Math.min(16, hand.length));
      const gridCols = Math.min(rowCap, hand.length);

      const gridW = gridCols * tw + (gridCols - 1) * gap;
      const startX = Math.floor((w - gridW) / 2);
      const startY = h - th - 24;

      for (let i = 0; i < hand.length; i++) {
        const col = i % rowCap;
        const row = Math.floor(i / rowCap);

        const x = startX + col * (tw + gap);
        const y = startY - row * (th + gap);

        const t = hand[i];

        const clickable =
          pub.phase === 'passing' ||
          (pub.phase === 'playing' && priv.seatIndex === pub.currentTurnSeat);

        const tileObj = this.makeTile(x, y, t, {
          clickable,
          onClick: () => bridge?.onHandTileClick?.(t, i),
        });

        this.handLayer.add(tileObj);
      }
    }

    private drawClaimBanner(tileId: string, fromSeat: number): void {
      const scene = this as unknown as Phaser.Scene;
      const w = scene.scale.width;

      const c = scene.add.container(0, 0);

      const g = scene.add.graphics();
      g.fillStyle(0x000000, 0.35);
      g.fillRect(0, 44, w, 28);

      const t = scene.add.text(16, 48, `CLAIM: ${tileId} from seat ${fromSeat}`, {
        fontSize: '14px',
      });

      c.add([g, t]);
      this.hudLayer.add(c);

      this.claimBar = c;
    }

    // ------------------------
    // Tile factory (graphics + text)
    // ------------------------
    private makeTile(
      x: number,
      y: number,
      label: string,
      opts: { clickable: boolean; onClick?: () => void },
    ): any {
      const scene = this as unknown as Phaser.Scene;
      const { w, h, r, fontSize } = this.tileStyle;

      const c = scene.add.container(x, y);

      const g = scene.add.graphics();
      g.fillStyle(0xf2efe6, 1);
      g.fillRoundedRect(0, 0, w, h, r);
      g.lineStyle(2, 0x2b2b2b, 1);
      g.strokeRoundedRect(0, 0, w, h, r);

      const txt = scene.add.text(6, 6, label, {
        fontSize: `${fontSize}px`,
        color: '#111',
        wordWrap: { width: w - 12 },
      });

      c.add([g, txt]);

      if (opts.clickable) {
        const hit = scene.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0);
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => opts.onClick?.());
        c.add(hit);
      }

      return c;
    }
  };
} */


/* import type Phaser from 'phaser';
import { PublicSnapshot, PrivateSnapshot } from '../core/socket.service';
type PhaserNS = typeof import('phaser');
export function createTableScene(Phaser: any) {
  const SceneBase = Phaser.Scene;
  return class TableScene extends SceneBase {
    private publicSnap: PublicSnapshot | null = null;
    private privateSnap: PrivateSnapshot | null = null;

    private handText?: any;
    private infoText?: any;

    private discardsText?: any;
    private exposuresText?: any;

    constructor() {
      super('table');
    }

    create() {
      const scene = this as unknown as Phaser.Scene;
      this.infoText = scene.add.text(20, 20, 'Waiting…', { fontSize: '18px' });
      this.handText = scene.add.text(20, 60, '', { fontSize: '16px' });

      this.discardsText = scene.add.text(20, 110, '', { fontSize: '14px' });
      this.exposuresText = scene.add.text(20, 150, '', { fontSize: '14px' });
      // IMPORTANT: render snapshots that may have arrived before create()
      this.setSnapshots(this.publicSnap, this.privateSnap);
    }

    setSnapshots(pub: PublicSnapshot | null, priv: PrivateSnapshot | null) {
      this.publicSnap = pub;
      this.privateSnap = priv;

      if (this.infoText && pub) {
        this.infoText.setText(
          `Room: ${pub.roomId} | ${pub.status} | Turn seat: ${pub.currentTurnSeat} | Wall: ${pub.wallCount} | v${pub.version}`,
        );
      }

      if (this.handText && priv) {
        this.handText.setText(`Hand: ${priv.hand.join(' ')}`);
      }

      if (this.discardsText && pub) {
        const tail = pub.discards.slice(-12);
        this.discardsText.setText(`Discards: ${tail.join(' ')}`);
      }

      if (this.exposuresText && pub) {
        const lines: string[] = [];
        for (const e of pub.exposures) {
          const melds = e.melds
            .map((m: any) => `${m.kind}:${m.tileId}(${m.tiles.length})`)
            .join(' | ');
          if (melds) lines.push(`Seat ${e.seatIndex}: ${melds}`);
        }
        this.exposuresText.setText(lines.length ? `Exposures:\n${lines.join('\n')}` : 'Exposures: (none)');
      }
    }
  };
} */

/* import Phaser from 'phaser';
import { PublicSnapshot, PrivateSnapshot } from '../core/socket.service';


export class TableScene extends Phaser.Scene {
  private publicSnap: PublicSnapshot | null = null;
  private privateSnap: PrivateSnapshot | null = null;

  private handText?: Phaser.GameObjects.Text;
  private infoText?: Phaser.GameObjects.Text;

  constructor() {
    super('table');
  }

  create() {
    this.infoText = this.add.text(20, 20, 'Waiting…', { fontSize: '18px' });
    this.handText = this.add.text(20, 60, '', { fontSize: '16px' });
  }

  setSnapshots(pub: PublicSnapshot | null, priv: PrivateSnapshot | null) {
    this.publicSnap = pub;
    this.privateSnap = priv;

    if (this.infoText && pub) {
      this.infoText.setText(
        `Room: ${pub.roomId} | ${pub.status} | Turn seat: ${pub.currentTurnSeat} | Wall: ${pub.wallCount} | v${pub.version}`,
      );
    }

    if (this.handText && priv) {
      this.handText.setText(`Hand: ${priv.hand.join(' ')}`);
    }
  }
} */

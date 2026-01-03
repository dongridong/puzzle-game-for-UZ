// Core Match-3 implementation with HTML5 Canvas rendering.
// The code separates board logic from rendering, keeps a clear state machine,
// and includes booster generation/combination behaviour.

// Pastel palette for softer block colors while keeping the classic hue order.
const COLORS = [
  "#FFB3A7", // pastel coral (red)
  "#FFD6A5", // pastel yellow (amber)
  "#CDB4DB", // lavender (purple)
  "#BDE0FE", // powder blue
  "#B8E0D2", // sage green
];

const TILE_SIZE = 60;
const BOARD_SIZE = 9;

const BoosterType = Object.freeze({
  NONE: "none",
  H_ROCKET: "h_rocket",
  V_ROCKET: "v_rocket",
  BOMB: "bomb",
});

const GameState = Object.freeze({
  IDLE: "Idle",
  SWAPPING: "Swapping",
  RESOLVING: "Resolving",
  FALLING: "Falling",
  ANIMATING: "Animating",
});

class Tile {
  constructor(color, booster = BoosterType.NONE, variant = null) {
    this.color = color;
    this.booster = booster;
    this.variant = variant; // visual variant for booster icons (e.g., arrow orientation, gem)
    this.id = crypto.randomUUID();
  }

  isBooster() {
    return this.booster !== BoosterType.NONE;
  }
}

class LevelConfig {
  constructor({ moves, objectives, targetTiles }) {
    this.moves = moves;
    this.objectives = objectives; // {colorHex: targetCount}
    this.targetTiles = targetTiles;
  }
}

const LEVELS = [
  new LevelConfig({ moves: 20, objectives: {}, targetTiles: 75 }),
  new LevelConfig({ moves: 20, objectives: {}, targetTiles: 100 }),
  new LevelConfig({ moves: 20, objectives: {}, targetTiles: 125 }),
  new LevelConfig({ moves: 20, objectives: {}, targetTiles: 150 }),
  new LevelConfig({ moves: 20, objectives: {}, targetTiles: 190 }),
];

class Board {
  constructor(size = BOARD_SIZE) {
    this.size = size;
    this.grid = this.createGrid();
  }

  createGrid() {
    const grid = Array.from({ length: this.size }, () => Array(this.size).fill(null));
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        grid[y][x] = this.randomTile();
      }
    }
    // Resolve initial accidental matches to avoid free clears.
    this.resolveInitialMatches(grid);
    return grid;
  }

  resolveInitialMatches(grid) {
    let dirty = true;
    while (dirty) {
      dirty = false;
      const matches = this.findMatches(grid);
      if (matches.length) {
        dirty = true;
        for (const match of matches) {
          for (const { x, y } of match.tiles) {
            grid[y][x] = this.randomTile();
          }
        }
      }
    }
  }

  randomTile() {
    return new Tile(COLORS[Math.floor(Math.random() * COLORS.length)]);
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  get(x, y) {
    return this.grid[y][x];
  }

  set(x, y, tile) {
    this.grid[y][x] = tile;
  }

  swap(a, b) {
    const temp = this.get(a.x, a.y);
    this.set(a.x, a.y, this.get(b.x, b.y));
    this.set(b.x, b.y, temp);
  }

  // Match detection scans horizontal and vertical lines. T/L shapes are
  // detected by checking intersections of perpendicular matches.
  findMatches(gridOverride = null) {
    const grid = gridOverride || this.grid;
    const matches = [];
    const size = this.size;

    // Horizontal matches
    for (let y = 0; y < size; y++) {
      let runStart = 0;
      for (let x = 1; x <= size; x++) {
        const current = x < size ? grid[y][x] : null;
        const prev = grid[y][x - 1];
        if (current && prev && current.color === prev.color && current.booster === prev.booster) {
          continue;
        }
        const runLength = x - runStart;
        if (runLength >= 3) {
          const tiles = [];
          for (let rx = runStart; rx < x; rx++) tiles.push({ x: rx, y });
          matches.push({ orientation: "horizontal", length: runLength, tiles });
        }
        runStart = x;
      }
    }

    // Vertical matches
    for (let x = 0; x < size; x++) {
      let runStart = 0;
      for (let y = 1; y <= size; y++) {
        const current = y < size ? grid[y][x] : null;
        const prev = grid[y - 1][x];
        if (current && prev && current.color === prev.color && current.booster === prev.booster) {
          continue;
        }
        const runLength = y - runStart;
        if (runLength >= 3) {
          const tiles = [];
          for (let ry = runStart; ry < y; ry++) tiles.push({ x, y: ry });
          matches.push({ orientation: "vertical", length: runLength, tiles });
        }
        runStart = y;
      }
    }

    // Identify T/L shapes: if a tile participates in both orientations.
    const coverage = new Map();
    for (const match of matches) {
      for (const pos of match.tiles) {
        const key = `${pos.x},${pos.y}`;
        coverage.set(key, (coverage.get(key) || 0) + 1);
      }
    }
    const tlTiles = new Set([...coverage.entries()].filter(([, count]) => count > 1).map(([k]) => k));
    for (const key of tlTiles) {
      const [x, y] = key.split(",").map(Number);
      const related = matches.filter((m) => m.tiles.some((t) => t.x === x && t.y === y));
      const union = new Map();
      related.forEach((m) => m.tiles.forEach((t) => union.set(`${t.x},${t.y}`, t)));
      matches.push({ orientation: "cross", length: union.size, tiles: [...union.values()], anchor: { x, y } });
    }

    // Deduplicate overlapping matches by unique tile sets.
    const unique = [];
    const seen = new Set();
    for (const match of matches) {
      const key = match.tiles
        .map((t) => `${t.x},${t.y}`)
        .sort()
        .join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(match);
    }

    return unique;
  }

  // After clearing, tiles fall down and new tiles spawn from the top.
  applyGravity(recordMoves = false) {
    const size = this.size;
    const moves = [];
    for (let x = 0; x < size; x++) {
      let writeY = size - 1;
      for (let y = size - 1; y >= 0; y--) {
        const tile = this.grid[y][x];
        if (tile) {
          this.grid[writeY][x] = tile;
          if (writeY !== y) {
            if (recordMoves) moves.push({ id: tile.id, x, fromY: y, toY: writeY });
            this.grid[y][x] = null;
          }
          writeY--;
        }
      }
      const missing = writeY + 1; // how many new tiles needed
      for (let y = writeY; y >= 0; y--) {
        const tile = this.randomTile();
        this.grid[y][x] = tile;
        if (recordMoves) moves.push({ id: tile.id, x, fromY: y - missing, toY: y });
      }
    }
    return moves;
  }

  // Clears tiles at provided positions and returns the cleared tiles for bookkeeping.
  clearTiles(positions) {
    const cleared = [];
    for (const { x, y } of positions) {
      const tile = this.get(x, y);
      if (tile) {
        cleared.push({ x, y, tile });
        this.set(x, y, null);
      }
    }
    return cleared;
  }

  // Handles match resolution, booster creation, and cascading.
  resolveMatches() {
    const allCleared = [];
    const boostersToSpawn = [];
    const gravitySteps = [];
    let matches = this.findMatches();

    while (matches.length) {
      const currentCleared = [];
      for (const match of matches) {
        const cleared = this.clearTiles(match.tiles);
        currentCleared.push(...cleared);

        // Decide booster creation: prioritize bombs for 5+ length or T/L shapes.
        let spawnBooster = null;
        let spawnVariant = null;
        if (match.orientation === "cross") {
          spawnBooster = BoosterType.BOMB;
          spawnVariant = "bomb";
        } else if (match.length >= 5) {
          spawnBooster = BoosterType.BOMB;
          spawnVariant = match.orientation === "horizontal" || match.orientation === "vertical" ? "gem" : "bomb";
        } else if (match.length === 4) {
          spawnBooster = match.orientation === "horizontal" ? BoosterType.H_ROCKET : BoosterType.V_ROCKET;
          spawnVariant = match.orientation === "horizontal" ? "arrow-h" : "arrow-v";
        }

        if (spawnBooster) {
          const anchor = match.anchor || match.tiles[Math.floor(match.tiles.length / 2)];
          boostersToSpawn.push({
            ...anchor,
            booster: spawnBooster,
            variant: spawnVariant,
            color: cleared[0]?.tile.color,
          });
        }
      }

      allCleared.push(...currentCleared);

      // Place boosters after tiles removed to avoid wiping them instantly.
      for (const spawn of boostersToSpawn) {
        this.set(spawn.x, spawn.y, new Tile(spawn.color, spawn.booster, spawn.variant));
      }

      boostersToSpawn.length = 0;
      gravitySteps.push(this.applyGravity(true));
      matches = this.findMatches();
    }

    return { cleared: allCleared, gravitySteps };
  }
}

class Renderer {
  constructor(canvas, board) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.board = board;
    this.animationQueue = [];
    this.tileOffset = TILE_SIZE + 4;
  }

  enqueue(animation) {
    this.animationQueue.push(animation);
  }

  draw(state) {
    const { ctx, board } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw background grid.
    ctx.fillStyle = "#0b1325";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw tiles.
    for (let y = 0; y < board.size; y++) {
      for (let x = 0; x < board.size; x++) {
        const tile = board.get(x, y);
        if (!tile) continue;
        const animOffset = this.getAnimationOffset(tile.id);
        const posX = x * this.tileOffset + (animOffset?.dx || 0);
        const posY = y * this.tileOffset + (animOffset?.dy || 0);
        this.drawTile(tile, posX, posY);
      }
    }

    this.animationQueue = this.animationQueue.filter((a) => !a.done);
    this.updateAnimations();
  }

  drawTile(tile, posX, posY) {
    const size = TILE_SIZE;
    const radius = 12;
    this.ctx.save();
    this.ctx.translate(12, 12);
    this.ctx.fillStyle = tile.color;
    this.roundRect(posX, posY, size, size, radius);
    this.ctx.shadowColor = "rgba(0,0,0,0.35)";
    this.ctx.shadowBlur = 8;
    this.ctx.fill();

    if (tile.isBooster()) {
      this.drawBoosterIcon(tile, posX, posY, size);
    }
    this.ctx.restore();
  }

  drawBoosterIcon(tile, x, y, size) {
    this.ctx.save();
    this.ctx.fillStyle = "rgba(255,255,255,0.9)";
    this.ctx.translate(12, 12);
    const inset = 14;
    if (tile.booster === BoosterType.H_ROCKET) {
      this.drawArrow(x, y + size / 2, size - inset * 2, 10, "horizontal");
    } else if (tile.booster === BoosterType.V_ROCKET) {
      this.drawArrow(x + size / 2, y, size - inset * 2, 10, "vertical");
    } else if (tile.booster === BoosterType.BOMB) {
      if (tile.variant === "gem") {
        this.drawDiamond(x + size / 2, y + size / 2, size / 2.4);
      } else {
        this.drawBomb(x + size / 2, y + size / 2, size / 2.8);
      }
    }
    this.ctx.restore();
  }

  drawArrow(cx, cy, length, thickness, orientation) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    if (orientation === "horizontal") {
      ctx.beginPath();
      ctx.moveTo(cx - length / 2, cy - thickness / 2);
      ctx.lineTo(cx + length / 2, cy - thickness / 2);
      ctx.lineTo(cx + length / 2, cy - thickness);
      ctx.lineTo(cx + length / 2 + 12, cy);
      ctx.lineTo(cx + length / 2, cy + thickness);
      ctx.lineTo(cx + length / 2, cy + thickness / 2);
      ctx.lineTo(cx - length / 2, cy + thickness / 2);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(cx - thickness / 2, cy - length / 2);
      ctx.lineTo(cx - thickness / 2, cy + length / 2);
      ctx.lineTo(cx - thickness, cy + length / 2);
      ctx.lineTo(cx, cy + length / 2 + 12);
      ctx.lineTo(cx + thickness, cy + length / 2);
      ctx.lineTo(cx + thickness / 2, cy + length / 2);
      ctx.lineTo(cx + thickness / 2, cy - length / 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  drawDiamond(cx, cy, size) {
    const ctx = this.ctx;
    const gradient = ctx.createLinearGradient(cx - size, cy - size, cx + size, cy + size);
    gradient.addColorStop(0, "rgba(255,255,255,0.95)");
    gradient.addColorStop(1, "rgba(255,255,255,0.65)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(cx, cy - size);
    ctx.lineTo(cx + size, cy);
    ctx.lineTo(cx, cy + size);
    ctx.lineTo(cx - size, cy);
    ctx.closePath();
    ctx.fill();
  }

  drawBomb(cx, cy, radius) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(30,41,59,0.95)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 4, 0, Math.PI * 2);
    ctx.stroke();
    // Fuse
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx + radius / 2, cy - radius);
    ctx.quadraticCurveTo(cx + radius, cy - radius - 6, cx + radius + 4, cy - radius - 2);
    ctx.stroke();
  }

  roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  getAnimationOffset(id) {
    const anim = this.animationQueue.find((a) => a.targetId === id && !a.done);
    return anim?.currentOffset || null;
  }

  updateAnimations() {
    const now = performance.now();
    for (const anim of this.animationQueue) {
      if (anim.done) continue;
      const progress = Math.min(1, (now - anim.start) / anim.duration);
      const easeFn = anim.easing || easeOutQuad;
      const eased = easeFn(progress);
      if (anim.mode === "fall") {
        anim.currentOffset = {
          dx: 0,
          dy: anim.startOffsetY * (1 - eased),
        };
      } else {
        anim.currentOffset = {
          dx: (anim.deltaX || 0) * eased,
          dy: (anim.deltaY || 0) * eased,
        };
      }
      if (progress >= 1) anim.done = true;
    }
  }
}

class Game {
  constructor(canvas) {
    this.board = new Board();
    this.renderer = new Renderer(canvas, this.board);
    this.state = GameState.IDLE;
    this.selected = null;
    this.devRestartCount = 0;
    this.maxClearedLevel = 0; // tracks cumulative keepsake art layers
    this.levels = LEVELS;
    this.levelIndex = 0;
    this.level = this.levels[this.levelIndex];
    this.movesLeft = this.level.moves;
    this.targetTiles = this.level.targetTiles;
    this.clearedTiles = 0;
    this.objectives = { ...this.level.objectives };
    this.statusEl = document.getElementById("status");
    this.movesEl = document.getElementById("moves");
    this.objectiveEl = document.getElementById("objective");
    this.gaugeCells = Array.from(document.querySelectorAll(".gauge__cell"));
    this.clearedEl = document.getElementById("cleared");
    this.targetEl = document.getElementById("target");
    this.restartBtn = document.getElementById("restartBtn");
    this.restartBtn.addEventListener("click", () => this.restartFromBeginning());
    this.celebrationEl = document.getElementById("celebration");
    this.celebrationTimeout = null;
    this.artCanvas = document.getElementById("artCanvas");
    this.artCtx = this.artCanvas?.getContext("2d");
    this.assets = {};
    this.loadAssets();
    this.loadLevel(this.levelIndex);
    this.updateHud();
    this.renderArt();
    this.bindInput(canvas);
    requestAnimationFrame(() => this.loop());
  }

  loadAssets() {
    this.assetsLoaded = false;
    this.assets = {};
  
    const loadImage = (key, src) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ key, img, ok: true });
        img.onerror = () => resolve({ key, img: null, ok: false, src });
        img.src = src;
      });
  
    Promise.all([
      loadImage("uj", "assets/uj.png"),
      loadImage("simandche", "assets/simandche.png"),
      loadImage("pepper", "assets/pepper.png"),
      loadImage("dh", "assets/dh.png"),
      loadImage("text", "assets/text.png"),
    ]).then((results) => {
      results.forEach(({ key, img, ok, src }) => {
        if (!ok) {
          console.warn(`[assets] failed to load: ${key} (${src})`);
          this.assets[key] = null;
          return;
        }
        this.assets[key] = img;
      });
  
      this.assetsLoaded = true;
      this.renderArt(); // 에셋 로드 완료 후 재렌더
    });
  }
  
  
  drawCharacterImage(ctx, img, cx, cy, scale = 0.6) {
    if (!img || !img.complete || img.naturalWidth === 0) return;
  
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
  
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  }  

  seedObjective(count) {
    const objectives = {};
    const colors = [...COLORS].sort(() => 0.5 - Math.random()).slice(0, 3);
    colors.forEach((c) => (objectives[c] = Math.floor(count / colors.length)));
    return objectives;
  }

  bindInput(canvas) {
    const posFromEvent = (e) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const x = Math.floor(((clientX - rect.left) / rect.width) * this.board.size);
      const y = Math.floor(((clientY - rect.top) / rect.height) * this.board.size);
      return { x, y };
    };

    const onDown = (e) => {
      e.preventDefault();
      if (this.state !== GameState.IDLE) return;
      this.selected = posFromEvent(e);
    };

    const onUp = (e) => {
      e.preventDefault();
      if (!this.selected || this.state !== GameState.IDLE) return;
      const release = posFromEvent(e);
      const dx = release.x - this.selected.x;
      const dy = release.y - this.selected.y;
      const adjacent = Math.abs(dx) + Math.abs(dy) === 1;
      if (adjacent) {
        this.handleSwap(this.selected, release);
      }
      this.selected = null;
    };

    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mouseup", onUp);
    canvas.addEventListener("touchstart", onDown, { passive: false });
    canvas.addEventListener("touchend", onUp, { passive: false });
  }

  loop() {
    this.renderer.draw(this.state);
    requestAnimationFrame(() => this.loop());
  }

  setState(newState) {
    this.state = newState;
    this.statusEl.textContent = newState;
  }

  loadLevel(index) {
    const clamped = Math.max(0, Math.min(index, this.levels.length - 1));
    this.levelIndex = clamped;
    this.level = this.levels[this.levelIndex];
    this.movesLeft = this.level.moves;
    this.targetTiles = this.level.targetTiles;
    this.clearedTiles = 0;
    this.objectives = { ...this.level.objectives };
    this.board = new Board();
    this.renderer.board = this.board;
    this.renderer.animationQueue = [];
    this.selected = null;
    this.setState(GameState.IDLE);
    this.hideCelebration();
    this.updateHud();
    this.renderArt();
  }

  restartFromBeginning() {
    this.devRestartCount += 1;
    if (this.devRestartCount >= 10) {
      this.devRestartCount = 0;
      this.clearedTiles = this.targetTiles;
      this.updateHud();
      this.triggerLevelComplete("Developer clear!");
      return;
    }
    this.restartLevel(false);
  }

  restartLevel(resetDevCounter = true) {
    if (resetDevCounter) this.devRestartCount = 0;
    this.loadLevel(this.levelIndex);
  }

  advanceLevel() {
    const nextIndex = Math.min(this.levelIndex + 1, this.levels.length - 1);
    this.devRestartCount = 0;
    this.loadLevel(nextIndex);
  }

  updateHud() {
    this.movesEl.textContent = this.movesLeft;
    this.targetEl.textContent = this.targetTiles;
    this.clearedEl.textContent = Math.min(this.clearedTiles, this.targetTiles);
    this.updateGauge();
    const objectives = `Level ${this.levelIndex + 1}: clear ${this.targetTiles} tiles`;
    this.objectiveEl.textContent = objectives;
  }

  updateGauge() {
    const ratio = this.targetTiles > 0 ? this.clearedTiles / this.targetTiles : 0;
    const filled = Math.min(10, Math.floor(ratio * 10));
    this.gaugeCells.forEach((cell, idx) => {
      cell.classList.toggle("filled", idx < filled);
    });
  }

  renderArt() {
    if (!this.artCtx || !this.artCanvas) return;
    const ctx = this.artCtx;
    const { width: w, height: h } = this.artCanvas;
  
    ctx.clearRect(0, 0, w, h);
  
    // Base backdrop (항상 그리기)
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#1d2a46");
    sky.addColorStop(1, "#0f172a");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
  
    // Soft floor
    ctx.fillStyle = "#101827";
    ctx.beginPath();
    ctx.moveTo(0, h * 0.78);
    ctx.quadraticCurveTo(w * 0.5, h * 0.72, w, h * 0.8);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();
  
    // 에셋이 아직이면 배경만 유지
    if (!this.assetsLoaded) return;
  
    // 여기서 절대 maxClearedLevel을 증가시키지 마세요 (버그)
    const stage = Math.min(5, this.maxClearedLevel);

    if (stage >= 4) this.drawDh(ctx, w, h);
    if (stage >= 1) this.drawUj(ctx, w, h);
    if (stage >= 2) this.drawSimandche(ctx, w, h);
    if (stage >= 3) this.drawPepper(ctx, w, h);
    if (stage >= 5) this.drawText(ctx, w, h);
  }
  

  drawHeart(ctx, x, y, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, size / 4);
    ctx.bezierCurveTo(0, -size / 2, -size, -size / 2, -size, size / 4);
    ctx.bezierCurveTo(-size, size, 0, size * 1.4, 0, size * 1.8);
    ctx.bezierCurveTo(0, size * 1.4, size, size, size, size / 4);
    ctx.bezierCurveTo(size, -size / 2, 0, -size / 2, 0, size / 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawUj(ctx, w, h) {
    this.drawCharacterImage(
      ctx,
      this.assets.uj,
      w * 0.64,
      h * 0.58,
      1.0125
    );
  }

  drawSimandche(ctx, w, h) {
    this.drawCharacterImage(
      ctx,
      this.assets.simandche,
      w * 0.68,
      h * 0.80,
      0.65
    );
  }

  drawPepper(ctx, w, h) {
    this.drawCharacterImage(
      ctx,
      this.assets.pepper,
      w * 0.32,
      h * 0.80,
      0.55
    );
  }

  drawDh(ctx, w, h) {
    this.drawCharacterImage(
      ctx,
      this.assets.dh,
      w * 0.33,
      h * 0.58,
      1.0125
    );
  }

  drawText(ctx, w, h) {
    this.drawCharacterImage(
      ctx,
      this.assets.text,
      w * 0.50,
      h * 0.16,
      0.6
    );
  }

  handleSwap(a, b) {
    if (this.movesLeft <= 0) return;
    const tileA = this.board.get(a.x, a.y);
    const tileB = this.board.get(b.x, b.y);

    this.setState(GameState.SWAPPING);
    this.animateSwap(tileA, tileB, a, b, () => {
      this.board.swap(a, b);
      const postTileA = this.board.get(a.x, a.y);
      const postTileB = this.board.get(b.x, b.y);

      // Booster + Booster combos resolve immediately without match detection.
      const comboHandled = this.handleBoosterCombo(a, b, postTileA, postTileB);
      if (comboHandled) return;

      const matches = this.board.findMatches();
      if (matches.length === 0) {
        // Invalid move: revert swap.
        this.animateSwap(postTileA, postTileB, b, a, () => {
          this.board.swap(a, b);
          this.setState(GameState.IDLE);
        });
        return;
      }

      this.movesLeft -= 1;
      this.updateHud();
      this.resolveBoard();
    });
  }

  animateSwap(tileA, tileB, posA, posB, onComplete) {
    const deltaX = (posB.x - posA.x) * this.renderer.tileOffset;
    const deltaY = (posB.y - posA.y) * this.renderer.tileOffset;
    const duration = 120;
    const start = performance.now();

    const animA = { targetId: tileA.id, deltaX, deltaY, start, duration, done: false };
    const animB = { targetId: tileB.id, deltaX: -deltaX, deltaY: -deltaY, start, duration, done: false };
    this.renderer.enqueue(animA);
    this.renderer.enqueue(animB);

    setTimeout(() => {
      onComplete?.();
    }, duration);
  }

  resolveBoard() {
    this.setState(GameState.RESOLVING);
    const { cleared, gravitySteps } = this.board.resolveMatches();
    this.countObjectives(cleared);
    this.updateHud();
    this.animateGravitySteps(gravitySteps, () => {
      this.setState(GameState.IDLE);
      this.checkEndConditions();
    });
  }

  countObjectives(cleared) {
    this.clearedTiles += cleared.length;
    cleared.forEach(({ tile }) => {
      if (this.objectives[tile.color] > 0) {
        this.objectives[tile.color] -= 1;
      }
    });
  }

  checkEndConditions() {
    const completed = this.clearedTiles >= this.targetTiles;
    if (completed) {
      this.triggerLevelComplete("Level Complete!");
    } else if (this.movesLeft <= 0) {
      this.statusEl.textContent = "Out of moves";
      this.setState(GameState.IDLE);
      setTimeout(() => this.restartLevel(), 300);
    }
  }

  triggerLevelComplete(message) {
    this.statusEl.textContent = message;
    this.maxClearedLevel = Math.max(this.maxClearedLevel, this.levelIndex + 1);
    this.renderArt();
    this.showCelebration();
    this.setState(GameState.IDLE);
    setTimeout(() => this.advanceLevel(), 600);
  }

  showCelebration() {
    if (!this.celebrationEl) return;
    if (this.celebrationTimeout) {
      clearTimeout(this.celebrationTimeout);
    }
    this.celebrationEl.textContent = `축하합니다! Level ${this.levelIndex + 1} 클리어!`;
    this.celebrationEl.classList.add("is-visible");
    this.celebrationTimeout = setTimeout(() => this.hideCelebration(), 1400);
  }

  hideCelebration() {
    if (!this.celebrationEl) return;
    this.celebrationEl.classList.remove("is-visible");
    if (this.celebrationTimeout) {
      clearTimeout(this.celebrationTimeout);
      this.celebrationTimeout = null;
    }
  }

  handleBoosterCombo(posA, posB, tileA, tileB) {
    if (!tileA.isBooster() && !tileB.isBooster()) return false;

    const effects = [];
    // If both boosters -> special combined pattern.
    if (tileA.isBooster() && tileB.isBooster()) {
      if (tileA.booster === BoosterType.BOMB || tileB.booster === BoosterType.BOMB) {
        // Bomb + anything: clear large area and entire row/col of other booster.
        effects.push(...this.areaAround(posA, 2));
        effects.push(...this.areaAround(posB, 2));
      }
      effects.push(...this.clearLineEffect(posA, "horizontal"));
      effects.push(...this.clearLineEffect(posA, "vertical"));
      effects.push(...this.clearLineEffect(posB, "horizontal"));
      effects.push(...this.clearLineEffect(posB, "vertical"));
    } else {
      // Single booster activated by swap.
      const boosterTile = tileA.isBooster() ? tileA : tileB;
      const boosterPos = tileA.isBooster() ? posA : posB;
      if (boosterTile.booster === BoosterType.H_ROCKET) {
        effects.push(...this.clearLineEffect(boosterPos, "horizontal"));
      } else if (boosterTile.booster === BoosterType.V_ROCKET) {
        effects.push(...this.clearLineEffect(boosterPos, "vertical"));
      } else if (boosterTile.booster === BoosterType.BOMB) {
        effects.push(...this.areaAround(boosterPos, 1));
      }
    }

    // Apply effects.
    const cleared = this.board.clearTiles(effects);
    const gravityMoves = this.board.applyGravity(true);
    this.countObjectives(cleared);
    this.movesLeft -= 1;
    this.updateHud();
    this.animateGravitySteps([gravityMoves], () => {
      this.setState(GameState.IDLE);
      this.checkEndConditions();
    });
    return true;
  }

  clearLineEffect(pos, orientation) {
    const positions = [];
    for (let i = 0; i < this.board.size; i++) {
      if (orientation === "horizontal") positions.push({ x: i, y: pos.y });
      else positions.push({ x: pos.x, y: i });
    }
    return positions;
  }

  areaAround(pos, radius) {
    const positions = [];
    for (let y = pos.y - radius; y <= pos.y + radius; y++) {
      for (let x = pos.x - radius; x <= pos.x + radius; x++) {
        if (this.board.inBounds(x, y)) positions.push({ x, y });
      }
    }
    return positions;
  }

  animateFalls(movements, onComplete) {
    if (!movements.length) {
      onComplete?.();
      return;
    }
    const duration = 360; // Slightly slower bounce so falls feel readable
    const start = performance.now();
    movements.forEach((move) => {
      const startOffsetY = (move.fromY - move.toY) * this.renderer.tileOffset;
      this.renderer.enqueue({
        targetId: move.id,
        startOffsetY,
        start,
        duration,
        easing: easeOutBounce,
        mode: "fall",
        done: false,
      });
    });
    setTimeout(() => onComplete?.(), duration);
  }

  animateGravitySteps(steps, onComplete) {
    const remaining = [...steps];
    const runNext = () => {
      if (!remaining.length) {
        onComplete?.();
        return;
      }
      const step = remaining.shift();
      if (!step.length) {
        runNext();
        return;
      }
      this.setState(GameState.FALLING);
      this.animateFalls(step, runNext);
    };
    runNext();
  }
}

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}

function easeOutBounce(t) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) {
    return n1 * t * t;
  }
  if (t < 2 / d1) {
    t -= 1.5 / d1;
    return n1 * t * t + 0.75;
  }
  if (t < 2.5 / d1) {
    t -= 2.25 / d1;
    return n1 * t * t + 0.9375;
  }
  t -= 2.625 / d1;
  return n1 * t * t + 0.984375;
}

// Bootstrap
window.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("gameCanvas");
  canvas.width = BOARD_SIZE * (TILE_SIZE + 4) + 24;
  canvas.height = BOARD_SIZE * (TILE_SIZE + 4) + 24;
  new Game(canvas);
});

// How to extend levels:
// - Instantiate LevelConfig with different move counts and objective maps.
// - Add obstacles by expanding the Tile model with durability and
//   modifying clearTiles to decrement durability instead of removal.
// - Introduce new boosters by extending BoosterType and drawing logic, then
//   hooking them into resolveMatches and handleBoosterCombo.

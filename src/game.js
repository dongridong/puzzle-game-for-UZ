// Core Match-3 implementation with HTML5 Canvas rendering.
// The code separates board logic from rendering, keeps a clear state machine,
// and includes booster generation/combination behaviour.

const COLORS = [
  "#f43f5e", // pink
  "#22c55e", // green
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#a855f7", // purple
  "#0ea5e9", // cyan for variety
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
  constructor(color, booster = BoosterType.NONE) {
    this.color = color;
    this.booster = booster;
    this.id = crypto.randomUUID();
  }

  isBooster() {
    return this.booster !== BoosterType.NONE;
  }
}

class LevelConfig {
  constructor({ moves, objectives }) {
    this.moves = moves;
    this.objectives = objectives; // {colorHex: targetCount}
  }
}

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
  applyGravity() {
    const size = this.size;
    for (let x = 0; x < size; x++) {
      let writeY = size - 1;
      for (let y = size - 1; y >= 0; y--) {
        const tile = this.grid[y][x];
        if (tile) {
          this.grid[writeY][x] = tile;
          if (writeY !== y) this.grid[y][x] = null;
          writeY--;
        }
      }
      for (let y = writeY; y >= 0; y--) {
        this.grid[y][x] = this.randomTile();
      }
    }
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
    let matches = this.findMatches();

    while (matches.length) {
      const currentCleared = [];
      for (const match of matches) {
        const cleared = this.clearTiles(match.tiles);
        currentCleared.push(...cleared);

        // Decide booster creation: prioritize bombs for 5+ length or T/L shapes.
        let spawnBooster = null;
        if (match.orientation === "cross" || match.length >= 5) {
          spawnBooster = BoosterType.BOMB;
        } else if (match.length === 4) {
          spawnBooster = match.orientation === "horizontal" ? BoosterType.H_ROCKET : BoosterType.V_ROCKET;
        }

        if (spawnBooster) {
          const anchor = match.anchor || match.tiles[Math.floor(match.tiles.length / 2)];
          boostersToSpawn.push({ ...anchor, booster: spawnBooster, color: cleared[0]?.tile.color });
        }
      }

      allCleared.push(...currentCleared);

      // Place boosters after tiles removed to avoid wiping them instantly.
      for (const spawn of boostersToSpawn) {
        this.set(spawn.x, spawn.y, new Tile(spawn.color, spawn.booster));
      }

      boostersToSpawn.length = 0;
      this.applyGravity();
      matches = this.findMatches();
    }

    return allCleared;
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
    this.ctx.fillStyle = "rgba(255,255,255,0.85)";
    this.ctx.translate(12, 12);
    const inset = 16;
    if (tile.booster === BoosterType.H_ROCKET) {
      this.ctx.fillRect(x + inset, y + size / 2 - 6, size - inset * 2, 12);
    } else if (tile.booster === BoosterType.V_ROCKET) {
      this.ctx.fillRect(x + size / 2 - 6, y + inset, 12, size - inset * 2);
    } else if (tile.booster === BoosterType.BOMB) {
      this.ctx.beginPath();
      this.ctx.arc(x + size / 2, y + size / 2, size / 4, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.restore();
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
      anim.currentOffset = {
        dx: anim.deltaX * easeOutQuad(progress),
        dy: anim.deltaY * easeOutQuad(progress),
      };
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
    this.level = new LevelConfig({
      moves: 30,
      objectives: this.seedObjective(20),
    });
    this.movesLeft = this.level.moves;
    this.objectives = { ...this.level.objectives };
    this.statusEl = document.getElementById("status");
    this.movesEl = document.getElementById("moves");
    this.objectiveEl = document.getElementById("objective");
    this.updateHud();
    this.bindInput(canvas);
    requestAnimationFrame(() => this.loop());
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

  updateHud() {
    this.movesEl.textContent = this.movesLeft;
    const objectives = Object.entries(this.objectives)
      .map(([color, remaining]) => `${remaining} of ${color}`)
      .join(", ");
    this.objectiveEl.textContent = objectives || "Completed!";
  }

  handleSwap(a, b) {
    if (this.movesLeft <= 0) return;
    const tileA = this.board.get(a.x, a.y);
    const tileB = this.board.get(b.x, b.y);

    this.setState(GameState.SWAPPING);
    this.animateSwap(tileA, tileB, a, b, () => {
      // Booster + Booster combos resolve immediately without match detection.
      const comboHandled = this.handleBoosterCombo(a, b, tileA, tileB);
      if (comboHandled) return;

      this.board.swap(a, b);
      const matches = this.board.findMatches();
      if (matches.length === 0) {
        // Invalid move: revert swap.
        this.board.swap(a, b);
        this.animateSwap(tileA, tileB, b, a, () => this.setState(GameState.IDLE));
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
      this.board.swap(posA, posB);
      onComplete?.();
    }, duration);
  }

  resolveBoard() {
    this.setState(GameState.RESOLVING);
    const cleared = this.board.resolveMatches();
    this.countObjectives(cleared);
    this.updateHud();
    this.setState(GameState.IDLE);
    this.checkEndConditions();
  }

  countObjectives(cleared) {
    cleared.forEach(({ tile }) => {
      if (this.objectives[tile.color] > 0) {
        this.objectives[tile.color] -= 1;
      }
    });
  }

  checkEndConditions() {
    const remaining = Object.values(this.objectives).reduce((sum, v) => sum + Math.max(0, v), 0);
    if (remaining === 0) {
      this.statusEl.textContent = "Level Complete!";
      this.setState(GameState.IDLE);
    } else if (this.movesLeft <= 0) {
      this.statusEl.textContent = "Out of moves";
      this.setState(GameState.IDLE);
    }
  }

  handleBoosterCombo(posA, posB, tileA, tileB) {
    if (!tileA.isBooster() && !tileB.isBooster()) return false;

    const effects = [];
    const positions = [posA, posB];
    const tiles = [tileA, tileB];
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
    this.board.applyGravity();
    this.countObjectives(cleared);
    this.movesLeft -= 1;
    this.updateHud();
    this.setState(GameState.IDLE);
    this.checkEndConditions();
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
}

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
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

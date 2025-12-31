# puzzle-game-for-UZ

puzzle game for UZ

## Testing the game
1. Run a local static server from the project root:
   ```bash
   python -m http.server 8000
   ```
2. Open the game in your browser at [http://localhost:8000](http://localhost:8000).
3. Verify core interactions:
   - Swap adjacent tiles and confirm only matches trigger a move.
   - Observe matches of 3 clearing tiles, 4 creating line rockets, and 5/T/L creating bombs.
   - Trigger booster combinations (rocket + rocket, bomb + rocket) and ensure full-area clears.
   - Check gravity/refill after clears and that move count and objectives update.
4. Game ends when objectives are met or moves reach zero; reset by refreshing the page.

These steps work on desktop and mobile; tap-and-drag is supported for touch screens.

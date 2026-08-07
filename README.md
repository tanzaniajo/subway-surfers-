# Subway Rush

A browser-based endless runner inspired by Subway Surfers, built with plain HTML5 Canvas and JavaScript — no frameworks, no build step, no external assets.

## Play

Just open `index.html` in a browser, or serve the folder locally:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Controls

- **Arrow Left / Right** (or **A / D**, or swipe): switch lanes
- **Arrow Up** (or **W**, **Space**, or swipe up): jump
- **Arrow Down** (or **S**, or swipe down): slide
- On-screen buttons are available for touch devices

## How it works

- Three-lane pseudo-3D perspective track (objects scale and move toward the camera as they approach)
- Obstacles: trains (switch lanes to dodge), low barriers (jump), overhead bars (slide)
- Coins to collect for bonus score, plus continuous distance-based scoring
- Game speed ramps up over time for increasing difficulty
- High score saved locally via `localStorage`
- Simple synthesized sound effects via the Web Audio API (no audio files)

## Project structure

```
index.html      Markup + UI overlays
css/style.css   Styling and layout
js/game.js      Game loop, physics, rendering, input
```

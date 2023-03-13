// This is the base UV map size, which is useful for scaling pixel counts.
export const UVMAP_SIZE = 600;

export const SPLATTER_ANIM_FRAMES = 8;

// Render a window of steps, so changes from the past can be reflected in our physics model
export const RENDERED_PHYSICS_STEP_WINDOW_SIZE = 100;

// This is stored as a flat array so that it can be imported into rust without
// messing with types or implementing serialization.
// For each color, there are 6 consecutive values. The first 3 are the r,g,b of
// the starting color, and the second 3 are the r,g,b of the ending color.
export const COLOR_PALATE_RS: number[] = [
  // Pink
  252, 73, 171, 223, 0, 122,
  // Light Blue
  95, 232, 255, 0, 197, 229,
  // Orange
  255, 153, 0, 211, 127, 0,
  // Green
  100, 255, 0, 94, 217, 15,
  // Blue
  57, 184, 255, 29, 157, 229,
  // Red
  255, 156, 156, 238, 126, 126,
  // Turquoise
  46, 214, 214, 39, 195, 195,
  // Magenta
  235, 10, 255, 213, 5, 232,
  // Citrine
  237, 200, 4, 219, 185, 9,
];

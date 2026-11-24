// Icons drawn on a pixel grid (GOAL.md 1a): whole-unit rects, crisp edges, no emoji.
// They take the text colour (fill: currentColor in app/theme.css) and are hidden from
// screen readers; every control that uses one has a text label.

const Pixels = ({ size, cells }: { size: [number, number]; cells: [number, number, number, number][] }) => (
  <svg className="px-icon" viewBox={`0 0 ${size[0]} ${size[1]}`} aria-hidden="true" focusable="false">
    {cells.map(([x, y, w, h], i) => (
      <rect key={i} x={x} y={y} width={w} height={h} />
    ))}
  </svg>
);

export const SearchIcon = () => (
  <Pixels
    size={[8, 8]}
    cells={[
      [1, 0, 3, 1],
      [0, 1, 1, 3],
      [4, 1, 1, 3],
      [1, 4, 3, 1],
      [4, 4, 1, 1],
      [5, 5, 1, 1],
      [6, 6, 2, 2],
    ]}
  />
);

export const PlusIcon = () => (
  <Pixels
    size={[7, 7]}
    cells={[
      [3, 0, 1, 7],
      [0, 3, 7, 1],
    ]}
  />
);

export const CrossIcon = () => (
  <Pixels
    size={[7, 7]}
    cells={[
      [0, 0, 1, 1],
      [1, 1, 1, 1],
      [2, 2, 1, 1],
      [3, 3, 1, 1],
      [4, 4, 1, 1],
      [5, 5, 1, 1],
      [6, 6, 1, 1],
      [6, 0, 1, 1],
      [5, 1, 1, 1],
      [4, 2, 1, 1],
      [2, 4, 1, 1],
      [1, 5, 1, 1],
      [0, 6, 1, 1],
    ]}
  />
);

export const CheckIcon = () => (
  <Pixels
    size={[8, 7]}
    cells={[
      [7, 0, 1, 1],
      [6, 1, 1, 1],
      [5, 2, 1, 1],
      [4, 3, 1, 1],
      [0, 3, 1, 1],
      [1, 4, 1, 1],
      [3, 4, 1, 1],
      [2, 5, 1, 1],
    ]}
  />
);

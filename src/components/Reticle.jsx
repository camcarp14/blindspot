// Signature element: a scope-reticle score dial. Ring fills with score,
// crosshair ticks stay fixed — reads as an instrument, not a progress bar.
export default function Reticle({ score, size = 56 }) {
  const r = size / 2 - 5
  const c = 2 * Math.PI * r
  const filled = c * (score / 100)
  const hot = score >= 70
  const warm = score >= 45
  const color = hot ? 'var(--sodium)' : warm ? 'var(--reticle)' : 'var(--dim)'

  return (
    <svg
      className="reticle"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`score ${score} of 100`}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--edge)" strokeWidth="1.5" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeDasharray={`${filled} ${c - filled}`}
        strokeLinecap="butt"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      {/* crosshair ticks */}
      {[0, 90, 180, 270].map((deg) => (
        <line
          key={deg}
          x1={size / 2}
          y1={1}
          x2={size / 2}
          y2={7}
          stroke="var(--dim)"
          strokeWidth="1.5"
          transform={`rotate(${deg} ${size / 2} ${size / 2})`}
        />
      ))}
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        className="reticle-num"
        fill={color}
      >
        {score}
      </text>
    </svg>
  )
}

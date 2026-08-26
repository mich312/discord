// One class string, built once.
//
// §5.7 bans building a class name with a ternary that repeats the base —
// `className={on ? 'room-chip active' : 'room-chip'}`. It reads as two
// class names rather than one class and one state, so renaming the base
// means finding both halves, and a state that should compose with another
// state turns into a four-way ternary. There were 52 of them.
//
// Falsy entries drop out, so a state is `cx('room-chip', on && 'active')`
// and the base appears exactly once.
export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

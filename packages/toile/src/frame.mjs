/**
 * Which way a model faces, and what its lengthwise sections are called.
 *
 * +Y is up. Left and front are a sign each, on X and on Z, and they are a
 * measurement where the model has one: Assetto Corsa requires every car to
 * name WHEEL_LF/RF/LR/RR, so its wheels say. Anything without wheels has to
 * be told, and the profile records which it was, so a stated facing is never
 * mistaken for a measured one.
 */
import { axesFromWheels, axisHints } from './model.mjs';

/** A recorded facing, `+X` or `-Z`, as the sign it stands for. */
export const SIGN = { '+X': 1, '-X': -1, '+Z': 1, '-Z': -1 };

/**
 * The facing, from the wheels, else as stated, else from mesh names.
 *
 * The wheels win over a stated facing: measurement wins where it has
 * something to say. A disagreement is said, because it means the person
 * stating it is looking at a different model than they think.
 */
export function facing(model, { stated = null, log = () => {} } = {}) {
  if (stated && !(['+X', '-X'].includes(stated.left) && ['+Z', '-Z'].includes(stated.front))) {
    throw new Error(`a facing is { left: '+X' or '-X', front: '+Z' or '-Z' }, not ${JSON.stringify(stated)}`);
  }
  const wheels = axesFromWheels(model);
  if (wheels) {
    if (stated && (SIGN[stated.left] !== wheels.left || SIGN[stated.front] !== wheels.front)) {
      log(`  ! the stated facing (${stated.left} left, ${stated.front} front) disagrees with the wheels. The wheels are used.`);
    }
    return { ...wheels, from: 'wheels' };
  }
  const hint = axisHints(model);
  if (!stated) return { ...hint, from: 'mesh names' };
  if (hint.confident && (SIGN[stated.left] !== hint.left || SIGN[stated.front] !== hint.front)) {
    log(`  ! the stated facing (${stated.left} left, ${stated.front} front) disagrees with the mesh names. The stated facing is used.`);
  }
  return { left: SIGN[stated.left], front: SIGN[stated.front], confident: true, from: 'stated' };
}

/**
 * The sections from front to back, each a band of the length measured from
 * the back (0) to the front (1): a name, where it starts and ends, and the
 * width that "half the band" is judged against. The bands at either end are
 * open, so an extent that reaches past the model still counts. Panel names
 * and tags both read it, so the two cannot place a cut differently.
 */
export const SECTIONS = [
  ['nose', 0.82, Infinity, 0.18], ['front', 0.62, 0.82, 0.2], ['mid', 0.38, 0.62, 0.24],
  ['rear', 0.18, 0.38, 0.2], ['tail', -Infinity, 0.18, 0.18],
];

/**
 * The section a point this far along the length (0 back, 1 front) is in. A
 * model with no extent to measure along gives NaN, which is the back.
 */
export const sectionAt = (along) => (SECTIONS.find(([, from]) => along > from) ?? SECTIONS.at(-1))[0];

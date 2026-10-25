import { describe, expect, it } from 'vitest';
import { FIXED_DT, MAX_STEPS, planSteps } from '../../client/src/canvas/GameLoop';
import { Camera } from '../../client/src/canvas/Camera';

/** Simula `seconds` de juego a una frecuencia de pantalla dada y cuenta los pasos fijos. */
function simulate(hz: number, seconds: number, jitter = 0): number {
  let acc = 0;
  let steps = 0;
  const frames = Math.round(hz * seconds);
  for (let i = 0; i < frames; i++) {
    const noise = jitter ? (i % 2 === 0 ? jitter : -jitter) : 0;
    const plan = planSteps(acc, 1 / hz + noise);
    acc = plan.accumulator;
    steps += plan.steps;
  }
  return steps;
}

describe('Bucle de juego con delta time', () => {
  it('ejecuta la misma lógica a 60, 120 y 144 Hz', () => {
    const expected = Math.round(10 / FIXED_DT);
    for (const hz of [60, 120, 144]) {
      expect(Math.abs(simulate(hz, 10) - expected)).toBeLessThanOrEqual(1);
    }
  });

  it('tolera variaciones pequeñas entre fotogramas', () => {
    const expected = Math.round(10 / FIXED_DT);
    expect(Math.abs(simulate(60, 10, 0.004) - expected)).toBeLessThanOrEqual(1);
  });

  it('limita los pasos tras una pausa prolongada', () => {
    const plan = planSteps(0, 5); // 5 s sin fotogramas
    expect(plan.steps).toBe(MAX_STEPS);
    expect(plan.accumulator).toBeLessThan(FIXED_DT);
    expect(planSteps(0, -1).steps).toBe(0);
  });

  it('la cámara sigue al objetivo igual con cualquier frecuencia de refresco', () => {
    const follow = (hz: number) => {
      const cam = new Camera();
      cam.setWorld(4000, 4000);
      cam.setViewport(960, 640);
      cam.snapTo(1000, 1000);
      for (let i = 0; i < hz; i++) cam.follow(2000, 1000, 1 / hz);
      return cam.x;
    };
    expect(follow(60)).toBeCloseTo(follow(144), 6);
  });
});

import { randomInt, randomUUID } from "node:crypto";
import type {
  DiceRng,
  DieFace,
  IdGenerator,
  PlayerId,
} from "./types";

const FACES: DieFace[] = [1, 2, 3, 4, 5, 6];

export class CryptoDiceRng implements DiceRng {
  chooseFirstPlayer(players: [PlayerId, PlayerId]): PlayerId {
    return randomInt(0, 2) === 0 ? players[0] : players[1];
  }

  rollD6(): DieFace {
    return randomInt(1, 7) as DieFace;
  }

  rollDifferentFace(excluded: DieFace): DieFace {
    const candidates = FACES.filter((face) => face !== excluded);
    const face = candidates[randomInt(0, candidates.length)];
    if (!face) throw new Error("No alternative die face is available.");
    return face;
  }
}

export class RandomIdGenerator implements IdGenerator {
  next(prefix: "game" | "die"): string {
    return `${prefix}_${randomUUID()}`;
  }
}

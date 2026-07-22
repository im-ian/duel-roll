import type { ReactNode } from "react";
import type { Die, LaneIndex } from "../game";

const PIPS: Record<Die["face"], number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="shield-icon">
      <path d="M12 2.6 20 6v5.2c0 5.1-3.2 8.6-8 10.2-4.8-1.6-8-5.1-8-10.2V6l8-3.4Z" />
      <path d="m8.5 12 2.2 2.2 4.8-5" />
    </svg>
  );
}

export function DieView({
  die,
  large = false,
  muted = false,
}: {
  die: Die;
  large?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`die ${large ? "die--large" : ""} ${
        die.kind === "SHIELD" ? "die--shield" : ""
      } ${muted ? "die--muted" : ""}`}
      aria-label={`${die.face} 눈${die.kind === "SHIELD" ? " 실드" : ""}`}
    >
      <span className="die__grid" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => (
          <i key={index} className={PIPS[die.face].includes(index) ? "on" : ""} />
        ))}
      </span>
      {die.kind === "SHIELD" && (
        <span className="die__shield">
          <ShieldIcon />
        </span>
      )}
    </div>
  );
}

export function DiceRow({
  dice,
  pickable = false,
  selectedId,
  onPick,
}: {
  dice: Die[];
  pickable?: boolean;
  selectedId?: string;
  onPick?: (dieId: string) => void;
}) {
  return (
    <div className="dice-row">
      {dice.map((die) => {
        const isSelected = selectedId === die.id;
        if (pickable && onPick) {
          return (
            <button
              type="button"
              key={die.id}
              className={`die-button ${isSelected ? "die-button--selected" : ""}`}
              onClick={() => onPick(die.id)}
              aria-pressed={isSelected}
            >
              <DieView die={die} />
            </button>
          );
        }
        return <DieView key={die.id} die={die} />;
      })}
      {Array.from({ length: 3 - dice.length }, (_, index) => (
        <span className="die-slot" key={`empty-${index}`} aria-hidden="true" />
      ))}
    </div>
  );
}

type TargetRowProps = {
  label: string;
  score: number;
  dice: Die[];
  action?: string;
  tone?: "place" | "attack" | "bonus" | "swap";
  disabled?: boolean;
  onClick?: () => void;
  dicePickable?: boolean;
  diceSelectedId?: string;
  onPickDie?: (dieId: string) => void;
};

export function TargetRow({
  label,
  score,
  dice,
  action,
  tone,
  disabled,
  onClick,
  dicePickable,
  diceSelectedId,
  onPickDie,
}: TargetRowProps) {
  const contents = (
    <>
      <span className="target-row__label">{label}</span>
      <DiceRow
        dice={dice}
        pickable={dicePickable}
        selectedId={diceSelectedId}
        onPick={onPickDie}
      />
      <span className="target-row__score">{score}</span>
      {action && <span className="target-row__action">{action}</span>}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={`target-row target-row--${tone ?? "place"}`}
        disabled={disabled}
        onClick={onClick}
        aria-label={`${label} 라인 ${action}`}
      >
        {contents}
      </button>
    );
  }
  return <div className="target-row">{contents}</div>;
}

export function LaneCard({
  lane,
  opponentDice,
  ownDice,
  opponentScore,
  ownScore,
  opponentAction,
  ownAction,
  swapMode = false,
  selectedOpponentDieId,
  selectedOwnDieId,
  onPickOpponentDie,
  onPickOwnDie,
  disabled,
}: {
  lane: LaneIndex;
  opponentDice: Die[];
  ownDice: Die[];
  opponentScore: number;
  ownScore: number;
  opponentAction?: { label: string; tone: "attack" | "bonus" | "swap"; run: () => void };
  ownAction?: { label: string; tone: "place" | "bonus" | "swap"; run: () => void };
  swapMode?: boolean;
  selectedOpponentDieId?: string;
  selectedOwnDieId?: string;
  onPickOpponentDie?: (dieId: string) => void;
  onPickOwnDie?: (dieId: string) => void;
  disabled?: boolean;
}) {
  const difference = ownScore - opponentScore;
  const verdict =
    difference > 0
      ? `내가 +${difference}`
      : difference < 0
        ? `상대가 +${Math.abs(difference)}`
        : "동률";
  return (
    <section
      className={`lane-card ${swapMode ? "lane-card--swap" : ""}`}
      aria-label={`${lane + 1}번 라인`}
    >
      <header className="lane-card__header">
        <span>LINE 0{lane + 1}</span>
        <span className={difference > 0 ? "ahead" : difference < 0 ? "behind" : ""}>
          {verdict}
        </span>
      </header>
      <TargetRow
        label="상대"
        score={opponentScore}
        dice={opponentDice}
        action={opponentAction?.label}
        tone={opponentAction?.tone}
        disabled={disabled}
        onClick={opponentAction?.run}
        dicePickable={swapMode}
        diceSelectedId={selectedOpponentDieId}
        onPickDie={onPickOpponentDie}
      />
      <TargetRow
        label="나"
        score={ownScore}
        dice={ownDice}
        action={ownAction?.label}
        tone={ownAction?.tone}
        disabled={disabled}
        onClick={ownAction?.run}
        dicePickable={swapMode}
        diceSelectedId={selectedOwnDieId}
        onPickDie={onPickOwnDie}
      />
    </section>
  );
}

export function Sheet({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="sheet__handle" aria-hidden="true" />
        <h2 id="sheet-title">{title}</h2>
        {description && <p>{description}</p>}
        <div className="sheet__actions">{children}</div>
      </section>
    </div>
  );
}

export function Spinner({ label = "불러오는 중" }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

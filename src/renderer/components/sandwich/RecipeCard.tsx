import type { CSSProperties } from 'react';
import { Leaf, User, Users } from 'lucide-react';
import type { SandwichData, SandwichItem, SandwichRecipe } from '@renderer/data/schema';
import { Badge, Card, TypeBadge, typeColor } from '@renderer/components/ui';
import { herbaOfIngredient, herbaRequirements, powerEffect, powerLabel } from './sandwich';
import styles from './Sandwich.module.css';

interface IngredientListProps {
  title: string;
  items: readonly SandwichItem[];
  herba: SandwichData['herba'];
}

function IngredientList({ title, items, herba }: IngredientListProps) {
  return (
    <div className={styles.ingredients}>
      <h4 className="eyebrow">{title}</h4>
      <ul>
        {items.map((item) => {
          const flavour = herbaOfIngredient(item.name, herba);
          return (
            <li key={item.name} data-herba={flavour ?? undefined}>
              {flavour ? <span className={styles.herbaDot} aria-hidden="true" /> : null}
              <span className={styles.ingredientName}>{item.name}</span>
              <span className={styles.quantity}>×{item.quantity}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LevelPips({ level }: { level: number }) {
  return (
    <span className={styles.pips} role="img" aria-label={`Level ${level}`}>
      {[1, 2, 3].map((step) => (
        <span key={step} data-on={step <= level || undefined} />
      ))}
      <span className={styles.pipText} aria-hidden="true">
        Lv. {level}
      </span>
    </span>
  );
}

export interface RecipeCardProps {
  recipe: SandwichRecipe;
  herba: SandwichData['herba'];
}

/** One sandwich: what goes in, the Herba Mystica it costs, and the meal powers it grants. */
export function RecipeCard({ recipe, herba }: RecipeCardProps) {
  const required = herbaRequirements(recipe, herba);
  const sparkling = recipe.sparklingLevel > 0;
  const headingId = `recipe-${recipe.id}`;

  return (
    <Card
      className={styles.recipe}
      accent={sparkling ? 'shiny' : 'teal'}
      padding="none"
      role="article"
      aria-labelledby={headingId}
      style={{ '--recipe-type': typeColor(recipe.type) } as CSSProperties}
    >
      <header className={styles.recipeHead}>
        <div className={styles.recipeTitle}>
          <TypeBadge type={recipe.type} size="sm" />
          <h3 id={headingId}>{recipe.name}</h3>
        </div>
        <div className={styles.recipeBadges}>
          {sparkling ? (
            <Badge tone="shiny" size="sm">
              Sparkling Lv. {recipe.sparklingLevel}
            </Badge>
          ) : (
            <Badge tone="teal" size="sm">
              Encounter only
            </Badge>
          )}
          {recipe.minimal ? (
            <Badge tone="violet" variant="outline" size="sm" icon={<Leaf />}>
              {recipe.herbaCount > 0 ? 'Minimum Herba' : 'No Herba needed'}
            </Badge>
          ) : null}
          <Badge
            tone="neutral"
            variant="outline"
            size="sm"
            icon={recipe.players > 1 ? <Users /> : <User />}
          >
            {recipe.players > 1 ? `${recipe.players} players` : 'Solo'}
          </Badge>
        </div>
      </header>

      <div className={styles.recipeBody}>
        <div className={styles.ingredientGrid}>
          <IngredientList title="Fillings" items={recipe.fillings} herba={herba} />
          <IngredientList title="Condiments" items={recipe.condiments} herba={herba} />
        </div>

        <div className={styles.herbaLine}>
          <h4 className="eyebrow">Herba Mystica</h4>
          {required.length > 0 ? (
            <p>
              <strong>{recipe.herbaCount}</strong> needed:{' '}
              {required.map((entry, index) => (
                <span key={entry.id} className={styles.herbaChip} data-herba={entry.id}>
                  <span className={styles.herbaDot} aria-hidden="true" />
                  {entry.name.replace(' Herba Mystica', '')} ×{entry.quantity}
                  {index < required.length - 1 ? <span className="sr-only">, </span> : null}
                </span>
              ))}
            </p>
          ) : (
            <p>None needed for this recipe.</p>
          )}
        </div>

        <div className={styles.powers}>
          <h4 className="eyebrow">Meal powers</h4>
          <ul>
            {recipe.powers.map((power) => {
              const effect = powerEffect(power);
              return (
                <li key={`${power.power}-${power.type ?? 'none'}`} data-power={power.power}>
                  <span className={styles.powerName}>
                    {powerLabel(power)}
                    {effect ? <span className={styles.powerEffect}>{effect}</span> : null}
                  </span>
                  <LevelPips level={power.level} />
                </li>
              );
            })}
          </ul>
        </div>

        {recipe.notes ? <p className={styles.recipeNotes}>{recipe.notes}</p> : null}
      </div>
    </Card>
  );
}

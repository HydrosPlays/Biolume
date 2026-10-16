/**
 * The app's default odds engine, built over the bundled `oddsMethods.json`.
 *
 * The JSON is trusted here: it is cast to the schema types without running the
 * zod validation, which keeps launch fast. `oddsData.test.ts` validates the
 * file and pins every checkpoint, so a broken data set fails the test-suite
 * rather than a user's session.
 *
 * Formulas for `custom` models live in `./oddsFormulas` and are registered
 * globally from this file, so that every consumer of `oddsEngine` (and the
 * conformance test, which builds its own engines) picks them up.
 */
import rawOddsData from '@renderer/data/oddsMethods.json';
import type { OddsData, SandwichData } from '@renderer/data/schema';
import { createOddsEngine, type OddsEngine } from './odds';
import { registerCustomFormulas } from './oddsFormulas';

// Global registration, before any engine evaluates: the default engine below and
// every engine built elsewhere over the same data resolve `custom` models here.
registerCustomFormulas();

// Through `unknown`: the type inferred from a JSON module widens literals
// (`kind: string`, `number[]` for an odds pair) and cannot be narrowed directly.
export const oddsData = rawOddsData as unknown as OddsData;

/** The SV sandwich tables for the sandwich helper. */
export const sandwichData: SandwichData = oddsData.sandwiches;

export const oddsEngine: OddsEngine = createOddsEngine(oddsData);

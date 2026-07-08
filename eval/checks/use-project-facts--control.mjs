// Control variant of use-project-facts: same fixture, NO seeded fact. Same hidden
// check (codegen-before-build ordering) — the pair measures fact-injection lift.
// This variant is informational (excluded from passRate); it is expected to fail
// the ordering check because, without the fact, the engine has no signal to run
// codegen first.
export { default } from './use-project-facts.mjs';

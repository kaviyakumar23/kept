/** Structured, serializable values. The event store persists only these — never raw text bodies. */
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

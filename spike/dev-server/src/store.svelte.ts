/** Experimental (#791): app-level state in a module, so HMR can be tested against component edits. */
export const counter = $state({ count: 0 });

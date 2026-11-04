/**
 * Count budgets for Main-owned ingress. Reconstructible observations can use sliding channels.
 * Commands and terminal streams backpressure producers to preserve ordered delivery.
 * Payload owners must additionally cap variable-size bodies before publication.
 */
export const MAIN_OBSERVATION_EVENT_CAPACITY = 1_024;
export const MAIN_RELIABLE_COMMAND_CAPACITY = 512;

/** The native PTY pauses at this many pending chunks and resumes as they drain. */
export const TERMINAL_OUTPUT_CHUNK_CAPACITY = 512;

/** Raised for a refused message or a postal-mime tree this build does not recognize. */
export class SpamAssassinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpamAssassinError";
  }
}

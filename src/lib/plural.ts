/** "1 operation", "2 operations": a count with its noun, so nothing reads "1 operations". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// Model- and repo-authored text reaches the UI and logs; strip control characters so it cannot inject escape sequences.
export const plain = (text: string): string => text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

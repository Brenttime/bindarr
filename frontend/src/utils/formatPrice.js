// Two decimals, and '0.00' for anything that does not parse as a number — null,
// undefined and '' all become NaN, which `|| 0` catches along with a genuine zero.
// parseFloat rather than Number, deliberately: it keeps the leniency the callers
// were written against, where a value like '12.50 USD' still reads as 12.50.
export const formatPrice = (p) => (parseFloat(p) || 0).toFixed(2);

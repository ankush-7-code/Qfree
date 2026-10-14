/** QFreee serves Jammu & Kashmir: providers are listed by district. */
export const JK_DISTRICTS = [
  // Jammu division
  'Doda', 'Jammu', 'Kathua', 'Kishtwar', 'Poonch', 'Rajouri', 'Ramban', 'Reasi', 'Samba', 'Udhampur',
  // Kashmir division
  'Anantnag', 'Bandipora', 'Baramulla', 'Budgam', 'Ganderbal', 'Kulgam', 'Kupwara', 'Pulwama', 'Shopian', 'Srinagar',
].sort();

/** The district's canonical spelling, or null if it is not a J&K district. */
export const jkDistrict = (raw: string) => JK_DISTRICTS.find((d) => d.toLowerCase() === raw.trim().toLowerCase()) ?? null;

// Small UI translation layer for the app's own screens (menu, security, energy, settings).
// Names and texts that come from Home Assistant (dashboard.yaml, entity names) are shown as they are.
export const LANGS = [["en", "English"], ["de", "Deutsch"], ["hu", "Magyar"]];
const LOCALES = { en: "en-GB", de: "de-CH", hu: "hu-HU" };

const de = {
  "Climate": "Klima", "Security": "Sicherheit", "Home": "Zuhause", "Energy": "Energie", "Settings": "Einstellungen",
  "Cockpit": "Übersicht", "Surveillance": "Überwachung", "{n} open": "{n} offen", "closed": "geschlossen",
  "All closed": "Alles geschlossen", "Everything closed": "Alles geschlossen",
  "All windows, doors and roof windows are closed": "Alle Fenster, Türen und Dachfenster sind geschlossen",
  "Windows": "Fenster", "Doors": "Türen", "Roof windows": "Dachfenster",
  "Open": "Offen", "Closed": "Geschlossen", "Locked": "Verriegelt", "Unlocked": "Entriegelt",
  "No cameras found in the dashboard.": "Keine Kameras im Dashboard gefunden.",
  "No window or door sensors found.": "Keine Fenster- oder Türsensoren gefunden.",
  "Today": "Heute", "7 days": "7 Tage", "30 days": "30 Tage", "This year": "Dieses Jahr",
  "Grid consumption": "Netzbezug", "Returned to grid": "Netzeinspeisung", "Solar": "Solar", "Battery in / out": "Batterie ein / aus",
  "Home usage": "Hausverbrauch", "Gas": "Gas", "Water": "Wasser", "Consumption": "Verbrauch", "Returned": "Eingespeist",
  "Electricity (kWh)": "Strom (kWh)", "Devices": "Geräte", "No data in this period": "Keine Daten in diesem Zeitraum",
  "Loading energy data…": "Energiedaten werden geladen…",
  "Could not read the energy configuration from Home Assistant.": "Die Energiekonfiguration konnte nicht aus Home Assistant gelesen werden.",
  "The Home Assistant energy dashboard has nothing configured.": "Im Energie-Dashboard von Home Assistant ist nichts konfiguriert.",
  "Language": "Sprache", "Account": "Konto", "Signed in as": "Angemeldet als", "Administrator": "Administrator", "User": "Benutzer",
  "Home Assistant": "Home Assistant", "Address": "Adresse", "Version": "Version", "Location": "Standort",
  "App": "App", "App version": "App-Version", "Reload app": "App neu laden", "Reload app hint": "Löscht den Zwischenspeicher und lädt die neueste Version.",
  "Sign out": "Abmelden", "Sign out?": "Abmelden?", "You will need to enter your username and password again on this device.": "Auf diesem Gerät müssen Benutzername und Passwort erneut eingegeben werden.",
  "Connected": "Verbunden", "Role": "Rolle", "Status": "Status", "Loading…": "Wird geladen…",
};
const hu = {
  "Climate": "Klíma", "Security": "Biztonság", "Home": "Otthon", "Energy": "Energia", "Settings": "Beállítások",
  "Cockpit": "Áttekintés", "Surveillance": "Megfigyelés", "{n} open": "{n} nyitva", "closed": "zárva",
  "All closed": "Minden zárva", "Everything closed": "Minden zárva",
  "All windows, doors and roof windows are closed": "Minden ablak, ajtó és tetőablak zárva van",
  "Windows": "Ablakok", "Doors": "Ajtók", "Roof windows": "Tetőablakok",
  "Open": "Nyitva", "Closed": "Zárva", "Locked": "Zárva", "Unlocked": "Nyitva",
  "No cameras found in the dashboard.": "Nincs kamera a vezérlőpulton.",
  "No window or door sensors found.": "Nincs ablak- vagy ajtóérzékelő.",
  "Today": "Ma", "7 days": "7 nap", "30 days": "30 nap", "This year": "Idén",
  "Grid consumption": "Hálózati fogyasztás", "Returned to grid": "Hálózatba visszatáplált", "Solar": "Napenergia", "Battery in / out": "Akku be / ki",
  "Home usage": "Ház fogyasztása", "Gas": "Gáz", "Water": "Víz", "Consumption": "Fogyasztás", "Returned": "Visszatáplált",
  "Electricity (kWh)": "Áram (kWh)", "Devices": "Eszközök", "No data in this period": "Nincs adat ebben az időszakban",
  "Loading energy data…": "Energiaadatok betöltése…",
  "Could not read the energy configuration from Home Assistant.": "Az energiabeállítás nem olvasható a Home Assistantból.",
  "The Home Assistant energy dashboard has nothing configured.": "A Home Assistant energia-vezérlőpultján nincs semmi beállítva.",
  "Language": "Nyelv", "Account": "Fiók", "Signed in as": "Bejelentkezve mint", "Administrator": "Adminisztrátor", "User": "Felhasználó",
  "Home Assistant": "Home Assistant", "Address": "Cím", "Version": "Verzió", "Location": "Helyszín",
  "App": "Alkalmazás", "App version": "Alkalmazás verziója", "Reload app": "Alkalmazás újratöltése", "Reload app hint": "Törli a gyorsítótárat és betölti a legújabb verziót.",
  "Sign out": "Kijelentkezés", "Sign out?": "Kijelentkezés?", "You will need to enter your username and password again on this device.": "Ezen az eszközön újra meg kell adnod a felhasználónevet és a jelszót.",
  "Connected": "Kapcsolódva", "Role": "Szerep", "Status": "Állapot", "Loading…": "Betöltés…",
};
const dict = { en: {}, de, hu };

let lang = "en";
try {
  const saved = localStorage.getItem("konihaus.lang");
  const nav = (navigator.language || "en").slice(0, 2);
  lang = saved && dict[saved] ? saved : (dict[nav] ? nav : "en");
} catch (e) { /* ignore */ }

export const getLang = () => lang;
export const locale = () => LOCALES[lang] ?? "en-GB";
export function setLang(l) { if (!dict[l]) return; lang = l; try { localStorage.setItem("konihaus.lang", l); } catch (e) { /* ignore */ } document.documentElement.lang = l; }
export const tr = (key, vars) => {
  let s = dict[lang][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
};
document.documentElement.lang = lang;

const CONSPIRACY_X_ACCOUNTS = [
  { handle: "RealAlexJones", label: "Alex Jones", category: "Deep State" },
  { handle: "MattWallace888", label: "Matt Wallace", category: "Epstein & Elites" },
  { handle: "VigilantFox", label: "The Vigilant Fox", category: "Medical" },
  { handle: "dom_lucre", label: "Dom Lucre", category: "Epstein & Elites" },
  { handle: "ShadowofEzra", label: "Shadow of Ezra", category: "QAnon" },
  { handle: "WarClandestine", label: "Clandestine", category: "Geopolitics" },
];

const CONSPIRACY_FOLLOWER_X_ACCOUNTS = [
  { handle: "odigdeeperDTRH", label: "Ghost Writer", category: "Community Leads" },
  { handle: "PaulJamesOBrie1", label: "Paul James O'Brien", category: "Community Leads" },
  { handle: "JamesWe70210481", label: "James West", category: "Deep State" },
  { handle: "WarriorDwarves", label: "Warrior Dwarves", category: "Community Leads" },
  { handle: "elcinbtmn", label: "Nancy W", category: "Community Leads" },
  { handle: "illuminati81841", label: "illuminatibot", category: "Occult & Symbols" },
  { handle: "paddyp155", label: "Patrick McLaughlin+44", category: "Occult & Symbols" },
  { handle: "kangspace589_", label: "KANG SPACE", category: "QAnon" },
  { handle: "TerteighthDEwF", label: "Terteighth", category: "Community Leads" },
  { handle: "NirwriNNkn", label: "Nirwri", category: "Community Leads" },
  { handle: "MpismearcA5V", label: "Mpismearc", category: "Community Leads" },
  { handle: "ThoythadrnKqw0", label: "Thoythadr", category: "Community Leads" },
  { handle: "shimomiyar72712", label: "Lilly", category: "Community Leads" },
  { handle: "Dathoos135863", label: "Fiona", category: "Community Leads" },
  { handle: "76s1dXRcZ50jA", label: "ClaraWood", category: "Community Leads" },
  { handle: "Anamkarananda", label: "Schellhase, Hermann", category: "Community Leads" },
  { handle: "Soughez192851", label: "Soughez", category: "Community Leads" },
  { handle: "Billy79799168", label: "Not_Billy", category: "Community Leads" },
  { handle: "Jr17Jfk", label: "John. Jr", category: "QAnon" },
  { handle: "RedCollie1", label: "Red Collie (Dr. Horace Drew)", category: "UFOs & Paranormal" },
];

const X_ACCOUNTS = [
  { handle: "Barchart", label: "Barchart", category: "Market Data" },

  { handle: "jasonpizzino", label: "Jason Pizzino", category: "Crypto Traders" },
  { handle: "TechDev_52", label: "TechDev", category: "Crypto Traders" },
  { handle: "TraderAlejito", label: "Trader Alejito", category: "Crypto Traders" },
  { handle: "trader1sz", label: "trader1sz", category: "Crypto Traders" },
  { handle: "RoccobullboTTom", label: "Roccobullbottom", category: "Crypto Traders" },
  { handle: "CryptoFaibik", label: "CryptoFaibik", category: "Crypto Traders" },
  { handle: "doerXBT", label: "doerXBT", category: "Crypto Traders" },
  { handle: "joker_szn", label: "joker_szn", category: "Crypto Traders" },
  { handle: "52kskew", label: "52kskew", category: "Crypto Traders" },
  { handle: "LH_btc", label: "LH_btc", category: "Crypto Traders" },
  { handle: "hupzy_agent", label: "hupzy_agent", category: "Crypto Traders" },

  { handle: "Luckshuryy", label: "Luckshuryy", category: "TA & Signals" },
  { handle: "wacy_time1", label: "wacy_time1", category: "TA & Signals" },
  { handle: "CoinSignals_", label: "CoinSignals_", category: "TA & Signals" },
  { handle: "leviathancrypto", label: "leviathancrypto", category: "TA & Signals" },
  { handle: "StockmoneyL", label: "StockmoneyL", category: "TA & Signals" },
  { handle: "clifton_ideas", label: "clifton_ideas", category: "TA & Signals" },
  { handle: "TATrader_Alan", label: "TATrader_Alan", category: "TA & Signals" },
  { handle: "CryptoCaesarTA", label: "CryptoCaesarTA", category: "TA & Signals" },
  { handle: "cryptic_heych", label: "cryptic_heych", category: "TA & Signals" },
  { handle: "CharTTrapperZ", label: "CharTTrapperZ", category: "TA & Signals" },

  ...CONSPIRACY_X_ACCOUNTS,
  ...CONSPIRACY_FOLLOWER_X_ACCOUNTS,
];

const X_ACCOUNT_PACKS = [
  { id: "conspiracy", accounts: CONSPIRACY_X_ACCOUNTS },
  { id: "conspiracy-followers-2026-09-10", accounts: CONSPIRACY_FOLLOWER_X_ACCOUNTS },
];

module.exports = {
  X_ACCOUNTS,
  CONSPIRACY_X_ACCOUNTS,
  CONSPIRACY_FOLLOWER_X_ACCOUNTS,
  X_ACCOUNT_PACKS,
};

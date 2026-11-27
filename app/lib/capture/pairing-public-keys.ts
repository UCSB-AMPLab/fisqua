/**
 * Capture Pairing — the environments' public keys
 *
 * This module holds the public half of each environment's pairing key
 * pair, the key the operator's storing command
 * (`scripts/commands/store-appliance-keys.ts`) seals a workspace's B2
 * key pairs with. A public key is safe to commit: it can only seal, and
 * only the private key opens what it sealed.
 *
 * Each entry is filled from the output of
 * `scripts/commands/pairing-keypair.ts --target <environment> --apply`,
 * which prints the public JWK on one line for this file. The same run
 * puts the private JWK in the operator's Keychain, and from there it is
 * set as the Worker secret `CAPTURE_KEYS_PRIVATE_JWK` of that
 * environment. An entry and its environment's secret are replaced
 * together. While an entry is null, the storing command refuses that
 * environment.
 *
 * @version v0.9.0
 */

export const PAIRING_PUBLIC_KEYS: Record<"production" | "staging", JsonWebKey | null> = {
  production: {
    kty: "EC",
    crv: "P-256",
    x: "vRdE4EvRYNHm6_sd6tNz6i-fLMvsruPxZ3N7LtyAe2Y",
    y: "WN-Xyv4OFe10iXQ4dvNmQ1zzqLyIRqVLJ_P-I5SoB-Y",
  },
  staging: {
    kty: "EC",
    crv: "P-256",
    x: "CgIKFZDlFncTA_zmO8mmnUxVOUKdiSmi5bjIDlP9Dj4",
    y: "-dsG3P68lYMXi-zd2Pvtg5PZLPmFVTd0DQV-auB2uO0",
  },
};

// @version v0.9.0

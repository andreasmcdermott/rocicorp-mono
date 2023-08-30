import * as v from 'shared/src/valita.js';
import {firestoreDataConverter} from './converter.js';
import * as path from './path.js';

export const teamSchema = v.object({
  name: v.string(),

  // Subdomain of reflect-server.net where apps are hosted, e.g.
  // https://app-name.team-subdomain.reflect-server.net
  //
  // This defaults to a sanitized version of the Team `name`, with a random
  // integer suffix added in the case of collisions. In the future, users will
  // have the ability to change the team name and subdomain.
  //
  // This field is denormalized to all of the Team's apps to simplify deployment logic.
  subdomain: v.string(),

  defaultCfID: v.string(),

  // Number of memberships of role 'admin'.
  // A team must have at least one admin.
  numAdmins: v.number(),
  // Number of memberships of role 'member'.
  numMembers: v.number(),
  numInvites: v.number(),

  numApps: v.number(),
  // null means default max
  maxApps: v.union(v.number(), v.null()),
});

export type Team = v.Infer<typeof teamSchema>;

export const teamDataConverter = firestoreDataConverter(teamSchema);

export const TEAM_COLLECTION = 'teams';

export function teamPath(teamID: string): string {
  return path.join(TEAM_COLLECTION, teamID);
}

export const teamSubdomainIndexSchema = v.object({
  teamID: v.string(),
});

export type TeamSubdomainIndex = v.Infer<typeof teamSubdomainIndexSchema>;

export const teamSubdomainIndexDataConverter = firestoreDataConverter(
  teamSubdomainIndexSchema,
);

export const TEAM_SUBDOMAIN_INDEX_COLLECTION = 'teamSubdomains';

export function teamSubdomainIndexPath(subdomain: string): string {
  return path.join(TEAM_SUBDOMAIN_INDEX_COLLECTION, subdomain);
}

const VALID_SUBDOMAIN = /^[a-z]([a-z0-9-])*[a-z0-9]$/;

export function isValidSubdomain(name: string): boolean {
  return VALID_SUBDOMAIN.test(name);
}

export function sanitizeForSubdomain(orig: string): string {
  return orig
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-') // Replace any sequences of illegal characters with a hyphens
    .replaceAll(/^[0-9-]*/g, '') // Remove leading digits or hyphens
    .replaceAll(/[-]*$/g, ''); // Remove trailing hyphens
}

export const appNameIndexSchema = v.object({
  appID: v.string(),
});

export type AppNameIndex = v.Infer<typeof appNameIndexSchema>;

export const appNameIndexDataConverter =
  firestoreDataConverter(appNameIndexSchema);

export const APP_NAME_INDEX_COLLECTION_ID = 'appNames';

export function appNameIndexPath(teamID: string, appName: string): string {
  return path.append(teamPath(teamID), APP_NAME_INDEX_COLLECTION_ID, appName);
}

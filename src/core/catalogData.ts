import bank2ynabConf from "../../catalog/bank2ynab.conf?raw";
import localConf from "../../catalog/local.conf?raw";
import { buildProfiles } from "./catalog";

/** All bank formats: bank2ynab's catalog (pinned copy) plus Sideload's local formats. */
export const PROFILES = buildProfiles(bank2ynabConf, localConf);

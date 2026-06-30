#pragma once

#include "deck_settings.h"

enum class DeckProvisioningError {
  None,
  MissingSsid,
  SsidTooLong,
  PasswordTooLong,
  MissingHubUrl,
  HubUrlTooLong,
  HubUrlScheme,
  HubUrlPath,
  MissingToken,
  TokenInvalid,
};

bool deckCopyString(char *dest, size_t destSize, const char *value);
bool loadDeckSettings(DeckSettings *out);
bool saveDeckSettings(const DeckSettings &settings);
bool clearDeckSettings();
bool validateDeckSettings(const DeckSettings &settings, DeckProvisioningError *error);
const char *deckProvisioningErrorName(DeckProvisioningError error);
bool runDeckProvisioningPortal(DeckSettings *current, const char *reason);

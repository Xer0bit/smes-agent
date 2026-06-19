import { writeSettings } from "../main/settings.js";

export function handleNeonOAuthReturn({
  token,
  refreshToken,
  expiresIn,
}: {
  token: string;
  refreshToken: string;
  expiresIn: number;
}) {
  writeSettings({
    neon: {
      accessToken: {
        value: token,
      },
      refreshToken: {
        value: refreshToken,
      },
      expiresIn,
      tokenTimestamp: Math.floor(Date.now() / 1000),
    },
  });
}

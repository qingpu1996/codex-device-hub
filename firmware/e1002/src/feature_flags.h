#pragma once

#ifndef FEATURE_MEAL
#define FEATURE_MEAL 1
#endif

#ifndef FEATURE_WEATHER
#define FEATURE_WEATHER 0
#endif

#if FEATURE_MEAL || FEATURE_WEATHER
#define FEATURE_SUBPAGES 1
#else
#define FEATURE_SUBPAGES 0
#endif

static constexpr bool kFeatureMealEnabled = FEATURE_MEAL != 0;
static constexpr bool kFeatureWeatherEnabled = FEATURE_WEATHER != 0;
static constexpr bool kFeatureSubpagesEnabled = FEATURE_SUBPAGES != 0;

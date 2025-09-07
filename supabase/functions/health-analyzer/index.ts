import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders } from "../_shared/cors.ts";

// Create a Supabase client with the admin service role key to bypass RLS
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SERVICE_ROLE_KEY") ?? ""
);

// This is the main server function that listens for webhook requests from the database.
serve(async (req) => {
  // Handle preflight CORS requests for browser compatibility.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Parse the incoming data payload from the database webhook.
    const payload = await req.json();
    console.log("Webhook received payload:", payload);
    const { type, record, table } = payload;

    // Route the request to the correct handler based on the table and event type.
    if (type === "INSERT" && table === "profiles") {
      await handleNewUser(record);
    } else if (type === "INSERT" && table === "reports") {
      await handleNewReport(record);
    }

    return new Response(JSON.stringify({ message: "Webhook processed successfully" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("Critical error in main serve function:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});

/**
 * Handles the automatic role assignment for a new user.
 * It checks the new user's phone number against a pre-approved list of officials.
 */
async function handleNewUser(user: any) {
  console.log(`Handling new user profile creation for user ID: ${user.id}`);
  const userPhoneNumber = user.phone;
  if (!userPhoneNumber) {
    console.log(`User ${user.id} has no phone number, skipping role check.`);
    return;
  }

  // Check if the phone number exists in the pre-approved list.
  const { data: approvedList, error } = await supabaseAdmin
    .from("pre_approved_officials")
    .select("phone_number")
    .eq("phone_number", userPhoneNumber)
    .limit(1);
  
  if(error) {
    console.error("Error checking pre-approved list:", error.message);
    return;
  }

  // If a match is found, update the user's role to 'OFFICIAL'.
  if (approvedList && approvedList.length > 0) {
    await supabaseAdmin
      .from("profiles")
      .update({ role: "OFFICIAL" })
      .eq("id", user.id);
    console.log(`Assigned OFFICIAL role to user ${user.id}`);
  } else {
    console.log(`User ${user.id} is a standard ASHA_WORKER.`);
  }
}

/**
 * Handles the advanced analysis of a newly submitted health report.
 * This function acts as the "ML model" for the system.
 */
async function handleNewReport(report: any) {
  // --- FIX: Re-fetch the report using an RPC to get clean lat/lon data ---
  const { data: reportData, error: rpcError } = await supabaseAdmin
    .rpc('get_report_with_geojson', { report_id: report.id });

  if (rpcError || !reportData) {
    console.error("Error fetching report details with RPC:", rpcError?.message);
  }
  
  const reportToAnalyze = reportData || report;
  console.log(`Analyzing new report ID: ${reportToAnalyze.id} for village: ${reportToAnalyze.village_name}`);
  
  let riskScore = 0;
  let riskLevel = "Normal";
  let weatherInfo = "No data";
  const analysisNotes = [];

  // --- 1. Temporal Analysis (Velocity) ---
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentReports, error: historyError } = await supabaseAdmin
    .from("reports")
    .select("diarrhea_cases")
    .eq("village_name", reportToAnalyze.village_name)
    .lt("created_at", reportToAnalyze.created_at)
    .gte("created_at", sevenDaysAgo);

  if (historyError) {
    console.error("Error fetching historical data:", historyError.message);
  } else if (recentReports && recentReports.length > 0) {
    const avgDiarrhea = recentReports.reduce((sum, r) => sum + r.diarrhea_cases, 0) / recentReports.length;
    if (avgDiarrhea > 0 && reportToAnalyze.diarrhea_cases > avgDiarrhea * 3) {
      riskScore += 40;
      analysisNotes.push("Case velocity is high (3x historical average).");
    }
  }

  // --- 2. Demographic Analysis ---
  if (reportToAnalyze.cases_in_children > 5) {
    riskScore += 50;
    analysisNotes.push("High number of cases in children under 5.");
  }

  // --- 3. Symptom Severity Analysis ---
  const totalCases = (reportToAnalyze.diarrhea_cases || 0) + (reportToAnalyze.fever_cases || 0) + (reportToAnalyze.vomiting_cases || 0);
  if (totalCases > 15) {
    riskScore += 30;
    analysisNotes.push("High total case count.");
  } else if (totalCases > 8) {
    riskScore += 15;
    analysisNotes.push("Moderate total case count.");
  }

  // --- 4. Environmental Analysis (Water & Weather) ---
  if (reportToAnalyze.water_source_tested === 'Community Well' || reportToAnalyze.water_source_tested === 'River') {
    riskScore += 10;
    analysisNotes.push(`Shared water source (${reportToAnalyze.water_source_tested}) adds risk.`);
  }

  const lat = reportToAnalyze.lat;
  const lon = reportToAnalyze.lon;

  if (lat && lon) {
    try {
      const openWeatherApiKey = Deno.env.get("OPENWEATHER_API_KEY");
      const weatherResponse = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${openWeatherApiKey}&units=metric`);
      if (weatherResponse.ok) {
        const weatherData = await weatherResponse.json();
        weatherInfo = `${weatherData.weather[0].description}, ${weatherData.main.temp}°C`;
        const recentRain = weatherData.weather[0].main.toLowerCase().includes("rain");
        if (recentRain) {
          riskScore += 10;
          analysisNotes.push("Recent rain increases contamination risk.");
        }
      } else {
        const errorBody = await weatherResponse.json();
        console.error("OpenWeatherMap API request failed:", errorBody);
        weatherInfo = `API Error: ${errorBody.message || 'Invalid Key?'}`;
      }
    } catch (error) {
      console.error("Error fetching weather data:", error.message);
      weatherInfo = "Fetch Error";
    }
  } else {
    weatherInfo = "Location could not be processed";
  }
  
  // --- 5. Determine Final Risk Level ---
  // --- THE CHANGE: More granular risk levels ---
  if (riskScore >= 75) {
    riskLevel = "Critical";
  } else if (riskScore >= 50) {
    riskLevel = "High";
  } else if (riskScore >= 25) {
    riskLevel = "Warning";
  } else if (riskScore >= 10) {
    riskLevel = "Low";
  } else {
    riskLevel = "Normal";
  }

  // --- 6. Update Report and Send Alert ---
  console.log(`Final determination for report ${reportToAnalyze.id}: Risk Level = ${riskLevel}`);
  const { error: updateError } = await supabaseAdmin
    .from("reports")
    .update({
      risk_level: riskLevel,
      weather_snapshot: weatherInfo,
      analysis_notes: analysisNotes.join(" ")
    })
    .eq("id", reportToAnalyze.id);

  if (updateError) {
    console.error("Error updating report in database:", updateError.message);
  } else {
    console.log(`Successfully updated report ${reportToAnalyze.id} in the database.`);
  }

  // Send alert for 'High' or 'Critical' risks
  if (riskLevel === "High" || riskLevel === "Critical") {
    console.log(`High/Critical risk detected. Sending SMS alert via Twilio...`);
    try {
      const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID");
      const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN");
      const twilioPhoneNumber = Deno.env.get("TWILIO_PHONE_NUMBER");
      const officialPhoneNumber = Deno.env.get("HEALTH_OFFICIAL_PHONE_NUMBER");

      const message = `ALERT [${riskLevel}]: Outbreak risk in ${reportToAnalyze.village_name}. Analysis: ${analysisNotes.join(" ")}. Check dashboard immediately.`;

      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
      const authHeader = "Basic " + btoa(`${twilioSid}:${twilioAuthToken}`);

      const response = await fetch(twilioUrl, {
          method: 'POST',
          headers: {
              'Authorization': authHeader,
              'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
              To: officialPhoneNumber,
              From: twilioPhoneNumber,
              Body: message
          })
      });
      if(response.ok) {
        console.log("SMS alert sent successfully.");
      } else {
        const errorBody = await response.json();
        console.error("Failed to send Twilio SMS:", errorBody);
      }
    } catch (error) {
        console.error("Error sending Twilio SMS:", error.message);
    }
  }
}


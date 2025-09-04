import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders } from "../_shared/cors.ts";

// Create a Supabase client with the admin service role key
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SERVICE_ROLE_KEY") ?? ""
);

serve(async (req) => {
  // This is a webhook, so it must be a POST request.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    console.log("Webhook received payload:", payload); // For debugging
    const { type, record, table } = payload;

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

// --- Helper Functions ---

async function handleNewUser(user: any) {
  console.log(`Handling new user profile creation for user ID: ${user.id}`);
  const userPhoneNumber = user.phone;
  if (!userPhoneNumber) {
    console.log(`User ${user.id} has no phone number, skipping role check.`);
    return;
  }

  const { data: approvedList, error } = await supabaseAdmin
    .from("pre_approved_officials")
    .select("phone_number")
    .eq("phone_number", userPhoneNumber)
    .limit(1);
  
  if(error) {
    console.error("Error checking pre-approved list:", error.message);
    return;
  }

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

// --- UPGRADED AND CORRECTED REPORT ANALYSIS LOGIC ---
async function handleNewReport(report: any) {
  console.log(`Analyzing new report ID: ${report.id} for village: ${report.village_name}`);
  let riskScore = 0;
  let riskLevel = "Normal";
  let weatherInfo = "No data";
  const analysisNotes = [];

  // --- 1. Temporal Analysis (Velocity) ---
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentReports, error: historyError } = await supabaseAdmin
    .from("reports")
    .select("diarrhea_cases")
    .eq("village_name", report.village_name)
    .lt("created_at", report.created_at)
    .gte("created_at", sevenDaysAgo);

  if (historyError) {
    console.error("Error fetching historical data:", historyError.message);
  } else if (recentReports && recentReports.length > 0) {
    const avgDiarrhea = recentReports.reduce((sum, r) => sum + r.diarrhea_cases, 0) / recentReports.length;
    if (avgDiarrhea > 0 && report.diarrhea_cases > avgDiarrhea * 3) {
      riskScore += 40;
      analysisNotes.push("Case velocity is high (3x historical average).");
    }
  }

  // --- 2. Demographic Analysis ---
  if (report.cases_in_children > 5) {
    riskScore += 50;
    analysisNotes.push("High number of cases in children under 5.");
  }

  // --- 3. Symptom Severity Analysis ---
  const totalCases = (report.diarrhea_cases || 0) + (report.fever_cases || 0) + (report.vomiting_cases || 0);
  if (totalCases > 15) {
    riskScore += 30;
    analysisNotes.push("High total case count.");
  } else if (totalCases > 8) {
    riskScore += 15;
    analysisNotes.push("Moderate total case count.");
  }

  // --- 4. Environmental Analysis (Water & Weather) ---
  if (report.water_source_tested === 'Community Well' || report.water_source_tested === 'River') {
    riskScore += 10;
    analysisNotes.push(`Shared water source (${report.water_source_tested}) adds risk.`);
  }

  let lat = null;
  let lon = null;
  if (report.location && typeof report.location === 'string') {
    try {
      const pointString = report.location.replace('POINT(', '').replace(')', '');
      const coords = pointString.split(' ');
      lon = parseFloat(coords[0]);
      lat = parseFloat(coords[1]);
    } catch (e) {
      console.error("Failed to parse location string:", report.location);
    }
  }

  if (lat && lon) {
    try {
      const openWeatherApiKey = Deno.env.get("OPENWEATHER_API_KEY");
      const weatherResponse = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${openWeatherApiKey}&units=metric`);
      if(weatherResponse.ok) {
        const weatherData = await weatherResponse.json();
        weatherInfo = `${weatherData.weather[0].description}, ${weatherData.main.temp}°C`;
        const recentRain = weatherData.weather[0].main.toLowerCase().includes("rain");
        if (recentRain) {
          riskScore += 10;
          analysisNotes.push("Recent rain increases contamination risk.");
        }
      }
    } catch (error) {
      console.error("Error fetching weather data:", error.message);
    }
  }
  
  // --- 5. Determine Final Risk Level ---
  if (riskScore >= 50) {
    riskLevel = "High";
  } else if (riskScore >= 25) {
    riskLevel = "Warning";
  }
  
  // --- 6. Update Report and Send Alert ---
  console.log(`Final determination for report ${report.id}: Risk Level = ${riskLevel}`);
  await supabaseAdmin
    .from("reports")
    .update({ 
      risk_level: riskLevel, 
      weather_snapshot: weatherInfo, 
      analysis_notes: analysisNotes.join(" ") 
    })
    .eq("id", report.id);

  if (riskLevel === "High") {
    console.log("High risk detected. Sending SMS alert via Twilio...");
    try {
      const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID");
      const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN");
      const twilioPhoneNumber = Deno.env.get("TWILIO_PHONE_NUMBER");
      const officialPhoneNumber = Deno.env.get("HEALTH_OFFICIAL_PHONE_NUMBER");

      const message = `ALERT: High risk detected in ${report.village_name}. Analysis: ${analysisNotes.join(" ")}. Check dashboard immediately.`;

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


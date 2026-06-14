#include <HTTPClient.h>
#include <WiFi.h>

// WiFi Settings - Replace with your actual credentials
const char *ssid = "ShresthWifi";
const char *password = "00000000";

// Supabase REST Endpoint Configuration
const char *supabase_url =
    "https://iitxvvfsfdoojwuacxhk.supabase.co/rest/v1/ecg_readings";
const char *supabase_anon_key =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpdHh2dmZzZmRvb2p3dWFjeGhrIiwicm9sZSI6Im"
    "Fub24iLCJpYXQiOjE3ODEwMDQ4OTYsImV4cCI6MjA5NjU4MDg5Nn0.W0HCntF00_"
    "6WNnZlzWI4Q17h7A7_exYBBuX276lBIAk";

// Hardware Configuration
const int ecgPin = 35; // Analog input pin connected to ECG sensor output

void setup() {
  Serial.begin(115200);
  pinMode(ecgPin, INPUT);

  // Set ADC attenuation to read full 0–3.3V range (default is 0–1.1V, causing 0 reads)
  analogSetPinAttenuation(ecgPin, ADC_11db);

  // Connect to Wi-Fi
  Serial.print("Connecting to WiFi");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  // === DIAGNOSTIC: Print 10 rapid ADC samples to Serial ===
  Serial.print("RAW ADC samples: ");
  for (int i = 0; i < 10; i++) {
    Serial.print(analogRead(ecgPin));
    Serial.print(" ");
    delay(10);
  }
  Serial.println();

  // Check WiFi connection status
  if (WiFi.status() == WL_CONNECTED) {
    // Read the analog value from GPIO35
    int ecgValue = analogRead(ecgPin);

    // Prepare the JSON payload
    // Table schema has 'value' column
    String jsonPayload = "{\"value\": " + String(ecgValue) + "}";

    HTTPClient http;

    // Begin connection over HTTPS
    http.begin(supabase_url);

    // Add required Supabase headers
    http.addHeader("Content-Type", "application/json");
    http.addHeader("apikey", supabase_anon_key);

    String authHeaderValue = "Bearer " + String(supabase_anon_key);
    http.addHeader("Authorization", authHeaderValue.c_str());

    // Send POST request
    Serial.print("Sending ECG Value: ");
    Serial.print(ecgValue);
    Serial.println(" to Supabase...");

    int httpResponseCode = http.POST(jsonPayload);

    // Check for response
    if (httpResponseCode > 0) {
      String response = http.getString();
      Serial.print("Success! HTTP Response Code: ");
      Serial.println(httpResponseCode);
      if (response.length() > 0) {
        Serial.print("Response: ");
        Serial.println(response);
      }
    } else {
      Serial.print("Error sending POST request. Error code: ");
      Serial.println(httpResponseCode);
    }

    // Free resources
    http.end();
  } else {
    Serial.println("WiFi Disconnected. Reconnecting...");
    WiFi.disconnect();
    WiFi.begin(ssid, password);
  }

  // Wait 1 second before next reading
  delay(1000);
}

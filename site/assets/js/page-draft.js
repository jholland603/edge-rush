/**
 * Draft War Room -- a self-contained fantasy draft-day board and pick
 * tracker. Unlike every other page on this site, this one has nothing to do
 * with the handicapping model: no D1/Worker calls, no games/teams/players
 * data. Everything lives in memory + localStorage, entirely client-side, so
 * it works offline at the kitchen table during an actual draft.
 *
 * State shape:
 *   settings: { teams, mySlot, scoring, draftType, roster: {QB,RB,WR,TE,FLEX,DST,K,BENCH}, auctionBudget }
 *   players:  [{ id, name, pos, posRank, team, bye, tier, rank, ecrVsAdp, flags: [] }]
 *             (rank/tier/posRank/bye/ecrVsAdp come from FantasyPros' 2026 PPR
 *             consensus board -- see the SEED_PLAYERS comment below for what
 *             each field means and where the value/trap flags come from)
 *   picks:    [{ overall, playerId, owner: 'me'|'other', paid?: number }], in the order they were made
 *   ui:       { posFilter, search, hideDrafted, activeTab }
 *
 * `picks` is append-only and IS the source of truth for "whose turn is it" --
 * the current overall pick number is always picks.length + 1. Nothing else
 * (my roster, the run tracker, the strategy nudges) is stored separately;
 * it's all derived fresh from players+picks+settings on every render. That
 * makes "Reset draft" and "Undo" trivial (just mutate `picks`) instead of
 * needing to keep three data structures in sync by hand.
 */
(function () {
  "use strict";

  const ROSTER_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "DST", "K", "BENCH"];
  const DEFAULT_ROSTER = { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, DST: 1, K: 1, BENCH: 6 };
  const POSES = ["ALL", "QB", "RB", "WR", "TE", "DST", "K"];

  // Flag -> [badge class, label]. Badge colors reuse the site's existing
  // positive/negative/neutral/warn vocabulary rather than inventing new ones.
  const FLAG_META = {
    anchor: ["positive", "anchor"],
    value: ["positive", "value"],
    injury: ["warn", "injury risk"],
    trap: ["negative", "⚠ sexy pick"],
    rookie: ["neutral", "rookie"],
    handcuff: ["neutral", "handcuff"],
  };

  // Starter board: FantasyPros' 2026 PPR Draft Rankings -- consensus of 108
  // experts, snapshotted Aug 25, 2026 (full 521-player/DST/K board). Each row
  // is [overallRank, name, pos, posRank, team, bye, tier, ecrVsAdp]:
  //   overallRank/tier   FantasyPros' own consensus rank + tier (1-16) grouping.
  //   posRank            rank within position (e.g. RB12).
  //   bye                bye week, or null where FantasyPros shows none (free
  //                      agents with no current team).
  //   ecrVsAdp           ECR minus ADP: positive = the field is drafting this
  //                      player LATER than the expert consensus (a value/
  //                      "falls to you" signal); negative = the field is
  //                      drafting them EARLIER than consensus (the market is
  //                      chasing name value ahead of where the room thinks he
  //                      belongs -- this is the "sexy pick" signal). null
  //                      means FantasyPros didn't have enough ADP samples yet.
  // This is a snapshot, not a live feed -- ADP drifts all preseason, so
  // re-import a fresh cheat-sheet CSV close to draft day (see the import note
  // above) if it's been more than a couple weeks since Aug 25, 2026.
  // prettier-ignore
  const SEED_PLAYERS = [
    [1,"Ja'Marr Chase","WR",1,"CIN",6,1,2],
    [2,"Jahmyr Gibbs","RB",1,"DET",6,1,-1],
    [3,"Puka Nacua","WR",2,"LAR",11,1,1],
    [4,"Bijan Robinson","RB",2,"ATL",11,1,-2],
    [5,"Jaxon Smith-Njigba","WR",3,"SEA",11,1,1],
    [6,"Amon-Ra St. Brown","WR",4,"DET",6,1,2],
    [7,"CeeDee Lamb","WR",5,"DAL",14,2,4],
    [8,"Justin Jefferson","WR",6,"MIN",6,2,4],
    [9,"Christian McCaffrey","RB",3,"SF",8,2,-4],
    [10,"Jonathan Taylor","RB",4,"IND",13,2,-3],
    [11,"Drake London","WR",7,"ATL",11,2,8],
    [12,"A.J. Brown","WR",8,"NE",11,3,8],
    [13,"Nico Collins","WR",9,"HOU",8,3,12],
    [14,"James Cook III","RB",5,"BUF",7,3,-5],
    [15,"Brock Bowers","TE",1,"LV",13,3,7],
    [16,"Chase Brown","RB",6,"CIN",6,3,-1],
    [17,"Chris Olave","WR",10,"NO",8,3,10],
    [18,"George Pickens","WR",11,"DAL",14,3,6],
    [19,"De'Von Achane","RB",7,"MIA",6,3,-9],
    [20,"Trey McBride","TE",2,"ARI",14,3,1],
    [21,"DeVonta Smith","WR",12,"PHI",10,4,13],
    [22,"Rashee Rice","WR",13,"KC",5,4,4],
    [23,"Saquon Barkley","RB",8,"PHI",10,4,-10],
    [24,"Malik Nabers","WR",14,"NYG",8,4,5],
    [25,"Omarion Hampton","RB",9,"LAC",7,4,-7],
    [26,"Josh Allen","QB",1,"BUF",7,4,-3],
    [27,"Kenneth Walker III","RB",10,"KC",5,4,-11],
    [28,"Ashton Jeanty","RB",11,"LV",13,4,-14],
    [29,"Garrett Wilson","WR",15,"NYJ",13,4,11],
    [30,"Zay Flowers","WR",16,"BAL",13,4,5],
    [31,"Lamar Jackson","QB",2,"BAL",13,4,10],
    [32,"Tetairoa McMillan","WR",17,"CAR",5,4,6],
    [33,"Ladd McConkey","WR",18,"LAC",7,4,11],
    [34,"Jaylen Waddle","WR",19,"DEN",10,4,14],
    [35,"Tee Higgins","WR",20,"CIN",6,4,7],
    [36,"Derrick Henry","RB",12,"BAL",13,5,-19],
    [37,"Colston Loveland","TE",3,"CHI",10,5,6],
    [38,"Drake Maye","QB",3,"NE",11,5,15],
    [39,"Breece Hall","RB",13,"NYJ",13,5,-6],
    [40,"Emeka Egbuka","WR",21,"TB",10,5,-1],
    [41,"Jeremiyah Love","RB",14,"ARI",14,5,-13],
    [42,"Kyren Williams","RB",15,"LAR",11,5,-12],
    [43,"Javonte Williams","RB",16,"DAL",14,5,-12],
    [44,"Josh Jacobs","RB",17,"GB",11,5,-12],
    [45,"Terry McLaurin","WR",22,"WAS",7,5,10],
    [46,"Joe Burrow","QB",4,"CIN",6,5,8],
    [47,"Luther Burden III","WR",23,"CHI",10,5,10],
    [48,"Travis Etienne Jr.","RB",18,"NO",8,5,-12],
    [49,"Davante Adams","WR",24,"LAR",11,5,1],
    [50,"DJ Moore","WR",25,"BUF",7,5,1],
    [51,"Jayden Daniels","QB",5,"WAS",7,5,11],
    [52,"Tyler Warren","TE",4,"IND",13,6,0],
    [53,"Mike Evans","WR",26,"SF",8,6,11],
    [54,"Jameson Williams","WR",27,"DET",6,6,4],
    [55,"D'Andre Swift","RB",19,"CHI",10,6,-8],
    [56,"Jalen Hurts","QB",6,"PHI",10,6,7],
    [57,"Cam Skattebo","RB",20,"NYG",8,6,-20],
    [58,"Rome Odunze","WR",28,"CHI",10,6,3],
    [59,"Christian Watson","WR",29,"GB",11,6,7],
    [60,"Bucky Irving","RB",21,"TB",10,6,-15],
    [61,"David Montgomery","RB",22,"HOU",8,6,-12],
    [62,"Quinshon Judkins","RB",23,"CLE",11,6,-16],
    [63,"Parker Washington","WR",30,"JAC",7,6,8],
    [64,"Caleb Williams","QB",7,"CHI",10,6,12],
    [65,"Bhayshul Tuten","RB",24,"JAC",7,6,-6],
    [66,"Carnell Tate","WR",31,"TEN",9,6,6],
    [67,"Marvin Harrison Jr.","WR",32,"ARI",14,6,6],
    [68,"TreVeyon Henderson","RB",25,"NE",11,6,-12],
    [69,"Justin Herbert","QB",8,"LAC",7,6,17],
    [70,"Jadarian Price","RB",26,"SEA",11,6,-10],
    [71,"Harold Fannin Jr.","TE",5,"CLE",11,6,-6],
    [72,"Jaylen Warren","RB",27,"PIT",9,7,-3],
    [73,"Chris Godwin Jr.","WR",33,"TB",10,7,22],
    [74,"Dak Prescott","QB",9,"DAL",14,7,1],
    [75,"Rhamondre Stevenson","RB",28,"NE",11,7,-1],
    [76,"Tucker Kraft","TE",6,"GB",11,7,-9],
    [77,"Trevor Lawrence","QB",10,"JAC",7,7,7],
    [78,"Brian Thomas Jr.","WR",34,"JAC",7,7,0],
    [79,"DK Metcalf","WR",35,"PIT",9,7,1],
    [80,"Michael Pittman Jr.","WR",36,"PIT",9,7,13],
    [81,"Kyle Pitts Sr.","TE",7,"ATL",11,7,-13],
    [82,"Courtland Sutton","WR",37,"DEN",10,7,-5],
    [83,"Tony Pollard","RB",29,"TEN",9,7,-2],
    [84,"Sam LaPorta","TE",8,"DET",6,7,-14],
    [85,"Wan'Dale Robinson","WR",38,"TEN",9,7,11],
    [86,"Josh Downs","WR",39,"IND",13,7,26],
    [87,"Michael Wilson","WR",40,"ARI",14,7,-2],
    [88,"Rico Dowdle","RB",30,"PIT",9,7,-9],
    [89,"Jonathon Brooks","RB",31,"CAR",5,7,-7],
    [90,"Brock Purdy","QB",11,"SF",8,7,21],
    [91,"Stefon Diggs","WR",41,"WAS",7,7,12],
    [92,"Quentin Johnston","WR",42,"LAC",7,7,16],
    [93,"RJ Harvey","RB",32,"DEN",10,7,-10],
    [94,"Jaxson Dart","QB",12,"NYG",8,7,-3],
    [95,"Travis Kelce","TE",9,"KC",5,7,-1],
    [96,"George Kittle","TE",10,"SF",8,7,-7],
    [97,"Chuba Hubbard","RB",33,"CAR",5,7,-9],
    [98,"J.K. Dobbins","RB",34,"DEN",10,8,-11],
    [99,"Kenny Gainwell","RB",35,"TB",10,8,0],
    [100,"Bo Nix","QB",13,"DEN",10,8,7],
    [101,"Alec Pierce","WR",43,"IND",13,8,-9],
    [102,"Patrick Mahomes II","QB",14,"KC",5,8,-1],
    [103,"Jakobi Meyers","WR",44,"JAC",7,8,11],
    [104,"Matthew Stafford","QB",15,"LAR",11,8,-14],
    [105,"Jayden Reed","WR",45,"GB",11,8,14],
    [106,"Jordan Addison","WR",46,"MIN",6,8,-1],
    [107,"Jared Goff","QB",16,"DET",6,8,16],
    [108,"Makai Lemon","WR",47,"PHI",10,8,7],
    [109,"Rachaad White","RB",36,"WAS",7,8,9],
    [110,"Blake Corum","RB",37,"LAR",11,8,-8],
    [111,"Dalton Kincaid","TE",11,"BUF",7,8,10],
    [112,"Aaron Jones Sr.","RB",38,"MIN",6,8,8],
    [113,"Kyler Murray","QB",17,"MIN",6,8,24],
    [114,"Jacory Croskey-Merritt","RB",39,"WAS",7,8,-5],
    [115,"Kyle Monangai","RB",40,"CHI",10,8,-15],
    [116,"Jake Ferguson","TE",12,"DAL",14,8,-6],
    [117,"Jordan Mason","RB",41,"MIN",6,8,-13],
    [118,"Dallas Goedert","TE",13,"PHI",10,8,-5],
    [119,"Baker Mayfield","QB",18,"TB",10,8,15],
    [120,"Jordan Love","QB",19,"GB",11,8,26],
    [121,"KC Concepcion","WR",48,"CLE",11,8,6],
    [122,"Khalil Shakir","WR",49,"BUF",7,8,18],
    [123,"Isaiah Likely","TE",14,"NYG",8,8,-17],
    [124,"Jalen Coker","WR",50,"CAR",5,8,21],
    [125,"Tyler Shough","QB",20,"NO",8,8,27],
    [126,"Romeo Doubs","WR",51,"NE",11,8,6],
    [127,"Xavier Worthy","WR",52,"KC",5,8,1],
    [128,"Matthew Golden","WR",53,"GB",11,8,-4],
    [129,"Malik Willis","QB",21,"MIA",6,8,39],
    [130,"Mark Andrews","TE",15,"BAL",13,8,-4],
    [131,"Jordyn Tyson","WR",54,"NO",8,9,-1],
    [132,"Juwan Johnson","TE",16,"NO",8,9,22],
    [133,"Woody Marks","RB",42,"HOU",8,9,2],
    [134,"Tyler Allgeier","RB",43,"ARI",14,9,9],
    [135,"Tyjae Spears","RB",44,"TEN",9,9,9],
    [136,"Chris Rodriguez Jr.","RB",45,"JAC",7,9,5],
    [137,"Sam Darnold","QB",22,"SEA",11,9,48],
    [138,"Deebo Samuel Sr.","WR",55,"SF",8,9,-9],
    [139,"C.J. Stroud","QB",23,"HOU",8,9,41],
    [140,"Dylan Sampson","RB",46,"CLE",11,9,56],
    [141,"De'Zhaun Stribling","WR",56,"SF",8,9,-16],
    [142,"Daniel Jones","QB",24,"IND",13,9,34],
    [143,"Denzel Boston","WR",57,"CLE",11,9,21],
    [144,"Rashid Shaheed","WR",58,"SEA",11,9,-2],
    [145,"Keaton Mitchell","RB",47,"LAC",7,9,12],
    [146,"Cam Ward","QB",25,"TEN",9,9,62],
    [147,"Zach Charbonnet","RB",48,"SEA",11,9,-9],
    [148,"Tyrone Tracy Jr.","RB",49,"NYG",8,9,1],
    [149,"Brenton Strange","TE",17,"JAC",7,9,11],
    [150,"Alvin Kamara","RB",50,"NO",8,9,-2],
    [151,"Chig Okonkwo","TE",18,"WAS",7,9,27],
    [152,"Jonah Coleman","RB",51,"DEN",10,9,15],
    [153,"Isiah Pacheco","RB",52,"DET",6,9,2],
    [154,"Hunter Henry","TE",19,"NE",11,9,2],
    [155,"Dalton Schultz","TE",20,"HOU",8,9,27],
    [156,"Tre Tucker","WR",59,"LV",13,9,25],
    [157,"Adonai Mitchell","WR",60,"NYJ",13,9,67],
    [158,"Jerry Jeudy","WR",61,"CLE",11,9,19],
    [159,"Houston Texans","DST",1,"HOU",8,9,-61],
    [160,"Jauan Jennings","WR",62,"MIN",6,9,44],
    [161,"Bryce Young","QB",26,"CAR",5,9,54],
    [162,"Tank Bigsby","RB",53,"PHI",10,9,8],
    [163,"Jalen McMillan","WR",63,"TB",10,10,43],
    [164,"Braelon Allen","RB",54,"NYJ",13,10,37],
    [165,"Mike Washington Jr.","RB",55,"LV",13,10,-15],
    [166,"Denver Broncos","DST",2,"DEN",10,10,-49],
    [167,"Tre' Harris","WR",64,"LAC",7,10,72],
    [168,"Los Angeles Rams","DST",3,"LAR",11,10,-52],
    [169,"Seattle Seahawks","DST",4,"SEA",11,10,-47],
    [170,"Brian Robinson Jr.","RB",56,"ATL",11,10,-7],
    [171,"Omar Cooper Jr.","WR",65,"NYJ",13,10,59],
    [172,"T.J. Hockenson","TE",21,"MIN",6,10,-11],
    [173,"MarShawn Lloyd","RB",57,"GB",11,10,17],
    [174,"Kayshon Boutte","WR",66,"HOU",8,10,58],
    [175,"Dontayvion Wicks","WR",67,"PHI",10,10,96],
    [176,"Ryan Flournoy","WR",68,"DAL",14,10,72],
    [177,"Jacoby Brissett","QB",27,"ARI",14,10,76],
    [178,"Pat Bryant","WR",69,"DEN",10,10,80],
    [179,"Philadelphia Eagles","DST",5,"PHI",10,10,-40],
    [180,"Malik Washington","WR",70,"MIA",6,10,51],
    [181,"Jalen Nailor","WR",71,"LV",13,10,18],
    [182,"Emmett Johnson","RB",58,"KC",5,10,53],
    [183,"Brandon Aubrey","K",1,"DAL",14,10,-86],
    [184,"Travis Hunter","WR",72,"JAC",7,10,39],
    [185,"Pittsburgh Steelers","DST",6,"PIT",9,10,-34],
    [186,"Keenan Allen","WR",73,"IND",13,10,-13],
    [187,"New England Patriots","DST",7,"NE",11,10,-34],
    [188,"Minnesota Vikings","DST",8,"MIN",6,10,-29],
    [189,"Kimani Vidal","RB",59,"LAC",7,10,58],
    [190,"Jaylin Noel","WR",74,"HOU",8,10,62],
    [191,"AJ Barner","TE",22,"SEA",11,10,-2],
    [192,"Calvin Ridley","WR",75,"TEN",9,10,-1],
    [193,"Cameron Dicker","K",2,"LAC",7,10,-62],
    [194,"Oronde Gadsden II","TE",23,"LAC",7,10,4],
    [195,"Sean Tucker","RB",60,"TB",10,10,55],
    [196,"Ray Davis","RB",61,"BUF",7,10,44],
    [197,"Jacksonville Jaguars","DST",9,"JAC",7,10,-25],
    [198,"Ka'imi Fairbairn","K",3,"HOU",8,10,-62],
    [199,"Los Angeles Chargers","DST",10,"LAC",7,10,-28],
    [200,"Cam Little","K",4,"JAC",7,10,-53],
    [201,"Tank Dell","WR",76,"HOU",8,10,-32],
    [202,"Baltimore Ravens","DST",11,"BAL",13,10,-44],
    [203,"Jason Myers","K",5,"SEA",11,10,-70],
    [204,"Gunnar Helm","TE",24,"TEN",9,10,78],
    [205,"Terrance Ferguson","TE",25,"LAR",11,10,2],
    [206,"Nicholas Singleton","RB",62,"TEN",9,10,37],
    [207,"James Conner","RB",63,"ARI",14,11,6],
    [208,"Geno Smith","QB",28,"NYJ",13,11,172],
    [209,"Tyler Loop","K",6,"BAL",13,11,-30],
    [210,"Kenyon Sadiq","TE",26,"NYJ",13,11,-44],
    [211,"Eddy Pineiro","K",7,"SF",8,11,-36],
    [212,"Aaron Rodgers","QB",29,"PIT",9,11,8],
    [213,"Kansas City Chiefs","DST",12,"KC",5,11,-21],
    [214,"Isaac TeSlaa","WR",77,"DET",6,11,30],
    [215,"Troy Franklin","WR",78,"DEN",10,11,71],
    [216,"Green Bay Packers","DST",13,"GB",11,11,-30],
    [217,"Darnell Mooney","WR",79,"NYG",8,11,49],
    [218,"Rashod Bateman","WR",80,"BAL",13,11,65],
    [219,"Jake Bates","K",8,"DET",6,11,-57],
    [220,"Cairo Santos","K",9,"CHI",10,11,-23],
    [221,"Cooper Kupp","WR",81,"SEA",11,11,-26],
    [222,"Jaydon Blue","RB",64,"DAL",14,11,20],
    [223,"Kaytron Allen","RB",65,"WAS",7,11,31],
    [224,"Emanuel Wilson","RB",66,"SEA",11,11,41],
    [225,"Pat Freiermuth","TE",27,"PIT",9,11,-4],
    [226,"Evan McPherson","K",10,"CIN",6,11,-33],
    [227,"Harrison Mevis","K",11,"LAR",11,11,-62],
    [228,"Germie Bernard","WR",82,"PIT",9,11,21],
    [229,"Detroit Lions","DST",14,"DET",6,11,-46],
    [230,"Cade Otton","TE",28,"TB",10,11,-5],
    [231,"Chase McLaughlin","K",12,"TB",10,11,-28],
    [232,"Andy Borregales","K",13,"NE",11,11,5],
    [233,"Zachariah Branch","WR",83,"ATL",11,11,3],
    [234,"Buffalo Bills","DST",15,"BUF",7,11,-40],
    [235,"Antonio Williams","WR",84,"WAS",7,11,20],
    [236,"Jaylen Wright","RB",67,"MIA",6,11,27],
    [237,"Cleveland Browns","DST",16,"CLE",11,11,-32],
    [238,"Ja'Kobi Lane","WR",85,"BAL",13,11,-64],
    [239,"Jack Bech","WR",86,"LV",13,11,58],
    [240,"Justice Hill","RB",68,"BAL",13,11,-7],
    [241,"Evan Engram","TE",29,"DEN",10,11,115],
    [242,"Greg Dulcich","TE",30,"MIA",6,11,-26],
    [243,"David Njoku","TE",31,"LAC",7,11,-34],
    [244,"George Holani","RB",69,"SEA",11,11,32],
    [245,"Malachi Fields","WR",87,"NYG",8,11,-23],
    [246,"Fernando Mendoza","QB",30,"LV",13,11,-36],
    [247,"Keon Coleman","WR",88,"BUF",7,11,14],
    [248,"Chimere Dike","WR",89,"TEN",9,11,84],
    [249,"Harrison Butker","K",14,"KC",5,11,-65],
    [250,"Devaughn Vele","WR",90,"NO",8,11,20],
    [251,"Ollie Gordon II","RB",70,"MIA",6,11,51],
    [252,"Kaelon Black","RB",71,"SF",8,11,-24],
    [253,"Chris Boswell","K",15,"PIT",9,11,-42],
    [254,"Ted Hurst III","WR",91,"TB",10,12,33],
    [255,"Chris Bell","WR",92,"MIA",6,12,12],
    [256,"Elic Ayomanor","WR",93,"TEN",9,12,55],
    [257,"Isaiah Davis","RB",72,"NYJ",13,12,288],
    [258,"Caleb Douglas","WR",94,"MIA",6,12,-44],
    [259,"Demond Claiborne","RB",73,"MIN",6,12,3],
    [260,"Tua Tagovailoa","QB",31,"ATL",11,12,31],
    [261,"Colby Parkinson","TE",32,"LAR",11,12,40],
    [262,"Najee Harris","RB",74,"NYG",8,12,-5],
    [263,"Tory Horton","WR",95,"SEA",11,12,36],
    [264,"Ty Johnson","RB",75,"BUF",7,12,53],
    [265,"LeQuint Allen Jr.","RB",76,"JAC",7,12,138],
    [266,"Christian Kirk","WR",96,"SF",8,12,-28],
    [267,"Samaje Perine","RB",77,"CIN",6,12,18],
    [268,"Tyquan Thornton","WR",97,"KC",5,12,158],
    [269,"Elijah Sarratt","WR",98,"BAL",13,12,74],
    [270,"Will Reichard","K",16,"MIN",6,12,-82],
    [271,"Darius Slayton","WR",99,"NYG",8,12,168],
    [272,"Jordan James","RB",78,"SF",8,12,-31],
    [273,"Chris Brooks","RB",79,"GB",11,12,128],
    [274,"Wil Lutz","K",17,"DEN",10,12,-62],
    [275,"Mason Taylor","TE",33,"NYJ",13,12,14],
    [276,"Xavier Legette","WR",100,"CAR",5,12,166],
    [277,"Cyrus Allen","WR",101,"KC",5,12,-75],
    [278,"Marvin Mims Jr.","WR",102,"DEN",10,12,17],
    [279,"Theo Johnson","TE",34,"NYG",8,12,45],
    [280,"Michael Penix Jr.","QB",32,"ATL",11,12,8],
    [281,"Kirk Cousins","QB",33,"LV",13,12,17],
    [282,"San Francisco 49ers","DST",17,"SF",8,12,-65],
    [283,"DJ Giddens","RB",80,"IND",13,12,20],
    [284,"Eli Stowers","TE",35,"PHI",10,12,-12],
    [285,"Malik Davis","RB",81,"DAL",14,12,41],
    [286,"Deshaun Watson","QB",34,"CLE",11,12,102],
    [287,"Trey Benson","RB",82,"FA",null,12,38],
    [288,"Shedeur Sanders","QB",35,"CLE",11,12,-32],
    [289,"Brashard Smith","RB",83,"KC",5,12,33],
    [290,"Devin Neal","RB",84,"NO",8,12,51],
    [291,"New Orleans Saints","DST",18,"NO",8,12,-62],
    [292,"Seth McGowan","RB",85,"IND",13,12,264],
    [293,"Atlanta Falcons","DST",19,"ATL",11,12,-48],
    [294,"Kendre Miller","RB",86,"NO",8,12,27],
    [295,"Hollywood Brown","WR",103,"PHI",10,12,21],
    [296,"Devin Singletary","RB",87,"NYG",8,12,9],
    [297,"Kyle Williams","WR",104,"NE",11,12,-20],
    [298,"Emari Demercado","RB",88,"KC",5,12,75],
    [299,"Adam Randall","RB",89,"BAL",13,12,307],
    [300,"Mike Gesicki","TE",36,"CIN",6,12,60],
    [301,"Isaiah Bond","WR",105,"CLE",11,12,182],
    [302,"Mack Hollins","WR",106,"NE",11,12,65],
    [303,"Kaleb Johnson","RB",90,"PIT",9,12,-29],
    [304,"Brandon Aiyuk","WR",107,"SF",8,12,-26],
    [305,"Skyler Bell","WR",108,"BUF",7,12,56],
    [306,"Trevor Etienne","RB",91,"CAR",5,13,260],
    [307,"Isaac Guerendo","RB",92,"SF",8,13,240],
    [308,"Andrei Iosivas","WR",109,"CIN",6,13,104],
    [309,"Indianapolis Colts","DST",20,"IND",13,13,-28],
    [310,"Chicago Bears","DST",21,"CHI",10,13,-110],
    [311,"Jerome Ford","RB",93,"WAS",7,13,299],
    [312,"Charlie Smyth","K",18,"NO",8,13,-4],
    [313,"Tyreek Hill","WR",110,"FA",null,13,-95],
    [314,"Tahj Brooks","RB",94,"CIN",6,13,126],
    [315,"Jarquez Hunter","RB",95,"LAR",11,13,76],
    [316,"Oscar Delp","TE",37,"NO",8,13,212],
    [317,"Audric Estime","RB",96,"NO",8,13,61],
    [318,"Jake Tonges","TE",38,"SF",8,13,-49],
    [319,"Jaleel McLaughlin","RB",97,"DEN",10,13,305],
    [320,"Darren Waller","TE",39,"CAR",5,13,93],
    [321,"Will Shipley","RB",98,"PHI",10,13,150],
    [322,"Darnell Washington","TE",40,"PIT",9,13,-29],
    [323,"Jahan Dotson","WR",111,"ATL",11,13,196],
    [324,"Michael Mayer","TE",41,"LV",13,13,120],
    [325,"Dallas Cowboys","DST",22,"DAL",14,13,-138],
    [326,"Elijah Arroyo","TE",42,"SEA",11,13,5],
    [327,"DeMario Douglas","WR",112,"NE",11,13,270],
    [328,"Jalen Tolbert","WR",113,"MIA",6,13,-13],
    [329,"J.J. McCarthy","QB",36,"MIN",6,13,-70],
    [330,"Bryce Lance","WR",114,"NO",8,13,105],
    [331,"Carson Beck","QB",37,"ARI",14,13,-25],
    [332,"Xavier Hutchinson","WR",115,"HOU",8,13,288],
    [333,"Charlie Kolar","TE",43,"LAC",7,13,134],
    [334,"Konata Mumpfield","WR",116,"LAR",11,13,14],
    [335,"Erick All Jr.","TE",44,"CIN",6,13,null],
    [336,"Kareem Hunt","RB",99,"FA",null,13,-6],
    [337,"Joe Mixon","RB",100,"FA",null,13,-47],
    [338,"Jalen Royals","WR",117,"KC",5,13,99],
    [339,"Cedric Tillman","WR",118,"CLE",11,13,311],
    [340,"Tez Johnson","WR",119,"TB",10,13,167],
    [341,"Chris Brazzell II","WR",120,"CAR",5,13,288],
    [342,"Tyler Higbee","TE",45,"LAR",11,13,-7],
    [343,"Bam Knight","RB",101,"ARI",14,13,null],
    [344,"Olamide Zaccheaus","WR",121,"ATL",11,13,240],
    [345,"Cole Kmet","TE",46,"CHI",10,13,-49],
    [346,"Mac Jones","QB",38,"SF",8,13,-18],
    [347,"Max Klare","TE",47,"LAR",11,13,15],
    [348,"Luke McCaffrey","WR",122,"WAS",7,13,-35],
    [349,"Eli Raridon","TE",48,"NE",11,13,-11],
    [350,"Calvin Austin III","WR",123,"NYG",8,13,42],
    [351,"Noah Gray","TE",49,"KC",5,13,7],
    [352,"Dawson Knox","TE",50,"BUF",7,13,-43],
    [353,"Kendrick Bourne","WR",124,"ARI",14,14,261],
    [354,"New York Giants","DST",23,"NYG",8,14,-128],
    [355,"Joshua Palmer","WR",125,"BUF",7,14,-19],
    [356,"Jake Elliott","K",19,"PHI",10,14,-129],
    [357,"Brenen Thompson","WR",126,"LAC",7,14,173],
    [358,"Carolina Panthers","DST",24,"CAR",5,14,-94],
    [359,"Ja'Tavion Sanders","TE",51,"CAR",5,14,-30],
    [360,"Justin Fields","QB",39,"KC",5,14,-37],
    [361,"Treylon Burks","WR",127,"WAS",7,14,242],
    [362,"Eli Heidenreich","RB",102,"PIT",9,14,null],
    [363,"Tennessee Titans","DST",25,"TEN",9,14,-103],
    [364,"Ty Simpson","QB",40,"LAR",11,14,-89],
    [365,"Malik Benson","WR",128,"LV",13,14,101],
    [366,"Trey Smack","K",20,"GB",11,14,-147],
    [367,"Tyler Bass","K",21,"BUF",7,14,-121],
    [368,"Justin Joly","TE",52,"DEN",10,14,84],
    [369,"Tampa Bay Buccaneers","DST",26,"TB",10,14,-135],
    [370,"Cincinnati Bengals","DST",27,"CIN",6,14,-102],
    [371,"Nick Folk","K",22,"ATL",11,14,-92],
    [372,"Zane Gonzalez","K",23,"FA",null,14,171],
    [373,"Kalif Raymond","WR",129,"CHI",10,14,145],
    [374,"Jawhar Jordan","RB",103,"HOU",8,14,190],
    [375,"Michael Carter","RB",104,"TEN",9,14,299],
    [376,"Kevin Coleman Jr.","WR",130,"MIA",6,14,232],
    [377,"Savion Williams","WR",131,"GB",11,14,250],
    [378,"Anthony Richardson Sr.","QB",41,"IND",13,14,37],
    [379,"Roman Wilson","WR",132,"PIT",9,14,80],
    [380,"Joe Flacco","QB",42,"CIN",6,14,-62],
    [381,"Dont'e Thornton Jr.","WR",133,"LV",13,14,14],
    [382,"Raheim Sanders","RB",105,"CLE",11,14,143],
    [383,"KaVontae Turpin","WR",134,"DAL",14,14,-32],
    [384,"Blake Grupe","K",24,"IND",13,14,-111],
    [385,"Noah Fant","TE",53,"NO",8,14,-6],
    [386,"Phil Mafah","RB",106,"DAL",14,14,null],
    [387,"John Metchie III","WR",135,"CAR",5,14,154],
    [388,"Roschon Johnson","RB",107,"CHI",10,14,197],
    [389,"Miami Dolphins","DST",28,"MIA",6,14,-95],
    [390,"Nick Westbrook-Ikhine","WR",136,"IND",13,14,210],
    [391,"Zavion Thomas","WR",137,"CHI",10,14,-44],
    [392,"Tommy Tremble","TE",54,"CAR",5,14,-27],
    [393,"Chad Ryland","K",25,"ARI",14,14,-73],
    [394,"Ryan Fitzgerald","K",26,"CAR",5,14,-61],
    [395,"Jaylin Lane","WR",138,"WAS",7,14,139],
    [396,"Colbie Young","WR",139,"CIN",6,14,-59],
    [397,"Washington Commanders","DST",29,"WAS",7,14,-113],
    [398,"Kyle Juszczyk","RB",108,"SF",8,14,-16],
    [399,"Luke Musgrave","TE",55,"GB",11,14,-9],
    [400,"Daniel Carlson","K",27,"NO",8,14,101],
    [401,"Devontez Walker","WR",140,"BAL",13,14,-56],
    [402,"CJ Daniels","WR",141,"LAR",11,14,146],
    [403,"Joey Slye","K",28,"TEN",9,14,-123],
    [404,"Tutu Atwell","WR",142,"MIA",6,14,178],
    [405,"Jameis Winston","QB",43,"NYG",8,14,-95],
    [406,"Demarcus Robinson","WR",143,"SF",8,14,44],
    [407,"J'Mari Taylor","RB",109,"JAC",7,14,null],
    [408,"Marcus Mariota","QB",44,"WAS",7,14,43],
    [409,"Brandon McManus","K",29,"FA",null,14,-9],
    [410,"Jam Miller","RB",110,"NE",11,14,null],
    [411,"Jordan Whittington","WR",144,"LAR",11,14,-69],
    [412,"John Bates","TE",56,"WAS",7,14,216],
    [413,"Mitchell Evans","TE",57,"CAR",5,14,null],
    [414,"Ashton Dulin","WR",145,"IND",13,14,216],
    [415,"Ben Sauls","K",30,"NYG",8,14,-101],
    [416,"Ben Sinnott","TE",58,"WAS",7,14,216],
    [417,"Cade Klubnik","QB",45,"NYJ",13,14,-64],
    [418,"Rasheen Ali","RB",111,"BAL",13,14,null],
    [419,"Las Vegas Raiders","DST",30,"LV",13,14,-168],
    [420,"Barion Brown","WR",146,"NO",8,14,50],
    [421,"Joe Milton III","QB",46,"DAL",14,14,-35],
    [422,"Sione Vaki","RB",112,"DET",6,14,null],
    [423,"Austin Hooper","TE",59,"ATL",11,15,56],
    [424,"Daniel Bellinger","TE",60,"TEN",9,15,169],
    [425,"New York Jets","DST",31,"NYJ",13,15,50],
    [426,"Austin Ekeler","RB",113,"FA",null,15,176],
    [427,"Tommy Myers","TE",61,"FA",null,15,null],
    [428,"Elijah Higgins","TE",62,"ARI",14,15,-60],
    [429,"Isaiah Williams","WR",147,"NYJ",13,15,197],
    [430,"Dameon Pierce","RB",114,"PHI",10,15,null],
    [431,"Spencer Shrader","K",31,"IND",13,15,-87],
    [432,"Hunter Luepke","RB",115,"DAL",14,15,-92],
    [433,"Jake Moody","K",32,"FA",null,15,-99],
    [434,"Dyami Brown","WR",148,"WAS",7,15,191],
    [435,"Tyler Goodson","RB",116,"ATL",11,15,null],
    [436,"Greg Dortch","WR",149,"DET",6,15,61],
    [437,"Marlin Klein","TE",63,"HOU",8,15,61],
    [438,"Khalil Herbert","RB",117,"SF",8,15,null],
    [439,"Jeremy McNichols","RB",118,"WAS",7,15,null],
    [440,"Dylan Laube","RB",119,"LV",13,15,null],
    [441,"Riley Leonard","QB",47,"IND",13,15,160],
    [442,"Elijah Moore","WR",150,"PHI",10,15,null],
    [443,"Jason Sanders","K",33,"NYJ",13,15,-124],
    [444,"Odell Beckham Jr.","WR",151,"NYG",8,15,-98],
    [445,"Damien Martinez","RB",120,"GB",11,15,null],
    [446,"Ty Chandler","RB",121,"NO",8,15,234],
    [447,"Tai Felton","WR",152,"MIN",6,15,30],
    [448,"Jonnu Smith","TE",64,"FA",null,15,null],
    [449,"Ronnie Rivers","RB",122,"LAR",11,15,null],
    [450,"Mitch Tinsley","WR",153,"CIN",6,15,191],
    [451,"Reggie Gilliam","RB",123,"NE",11,15,109],
    [452,"Roman Hemby","RB",124,"LV",13,15,null],
    [453,"Deion Burks","WR",154,"IND",13,15,null],
    [454,"Van Jefferson","WR",155,"WAS",7,15,120],
    [455,"Alec Ingold","RB",125,"LAC",7,15,180],
    [456,"Will Kacmarek","TE",65,"MIA",6,15,-92],
    [457,"Terrell Jennings","RB",126,"FA",null,15,null],
    [458,"Robert Henry Jr.","RB",127,"WAS",7,15,null],
    [459,"Patrick Ricard","RB",128,"NYG",8,15,103],
    [460,"Josh Oliver","TE",66,"MIN",6,15,-79],
    [461,"Arizona Cardinals","DST",32,"ARI",14,15,-154],
    [462,"Quinn Ewers","QB",48,"MIA",6,15,-88],
    [463,"Zavier Scott","RB",129,"MIN",6,15,null],
    [464,"Tim Patrick","WR",156,"NYJ",13,15,202],
    [465,"Zach Ertz","TE",67,"FA",null,15,142],
    [466,"Tyler Badie","RB",130,"DEN",10,15,null],
    [467,"Xavier Restrepo","WR",157,"TEN",9,15,null],
    [468,"Isaiah Williams","WR",158,"FA",null,15,null],
    [469,"Matt Hibner","TE",68,"BAL",13,15,null],
    [470,"Max Bredeson","RB",131,"MIN",6,15,70],
    [471,"Drew Stevens","K",34,"WAS",7,15,-167],
    [472,"Tanner Koziol","TE",69,"JAC",7,15,18],
    [473,"Cedrick Wilson Jr.","WR",159,"DET",6,15,187],
    [474,"Jacob Cowing","WR",160,"SF",8,15,null],
    [475,"Jordan Watkins","WR",161,"SF",8,15,null],
    [476,"Jimmy Horn Jr.","WR",162,"CAR",5,15,-13],
    [477,"Adam Prentice","RB",132,"DEN",10,15,161],
    [478,"Jahdae Walker","WR",163,"CHI",10,15,-81],
    [479,"Marquez Valdes-Scantling","WR",164,"DAL",14,15,15],
    [480,"Antonio Gibson","RB",133,"FA",null,15,133],
    [481,"British Brooks","RB",134,"HOU",8,15,173],
    [482,"Theo Wease Jr.","WR",165,"MIA",6,15,null],
    [483,"Jackson Hawes","TE",70,"BUF",7,15,-23],
    [484,"Xavier Smith","WR",166,"LAR",11,15,-51],
    [485,"Jacob Saylors","RB",135,"DET",6,15,138],
    [486,"Drew Allar","QB",49,"PIT",9,15,-174],
    [487,"Chris Blair","WR",167,"ATL",11,15,null],
    [488,"Sam Roush","TE",71,"CHI",10,15,67],
    [489,"Travis Homer","RB",136,"PIT",9,15,176],
    [490,"Jalen Reagor","WR",168,"MIA",6,15,null],
    [491,"Michael Woods II","WR",169,"DEN",10,15,null],
    [492,"Jake Browning","QB",50,"TB",10,15,-61],
    [493,"Luke Schoonmaker","TE",72,"DAL",14,16,-118],
    [494,"David Sills V","WR",170,"TB",10,16,null],
    [495,"Dominic Zvada","K",35,"NYG",8,16,-132],
    [496,"Tyrod Taylor","QB",51,"GB",11,16,-141],
    [497,"Cade Stover","TE",73,"HOU",8,16,27],
    [498,"DeAndre Hopkins","WR",171,"BAL",13,16,5],
    [499,"Kene Nwangwu","RB",137,"NYJ",13,16,null],
    [500,"Mason Rudolph","QB",52,"PIT",9,16,-15],
    [501,"Gardner Minshew II","QB",53,"ARI",14,16,58],
    [502,"Jeremy Ruckert","TE",74,"NYJ",13,16,31],
    [503,"Drew Sample","TE",75,"CIN",6,16,18],
    [504,"Adam Trautman","TE",76,"DEN",10,16,-81],
    [505,"Tanner Hudson","TE",77,"CIN",6,16,null],
    [506,"Michael Burton","RB",138,"CLE",11,16,133],
    [507,"Durham Smythe","TE",78,"BAL",13,16,2],
    [508,"Tyler Lockett","WR",172,"LV",13,16,null],
    [509,"Nate Boerkircher","TE",79,"JAC",7,16,18],
    [510,"KeAndre Lambert-Smith","WR",173,"LAC",7,16,-46],
    [511,"Noah Whittington","RB",139,"HOU",8,16,null],
    [512,"Miles Sanders","RB",140,"FA",null,16,null],
    [513,"Tyler Conklin","TE",80,"DET",6,16,38],
    [514,"Jermaine Burton","WR",174,"FA",null,16,null],
    [515,"Elijah Mitchell","RB",141,"FA",null,16,null],
    [516,"Frank Gore Jr.","RB",142,"BUF",7,16,73],
    [517,"Trey Lance","QB",54,"LAC",7,16,-62],
    [518,"Jaydn Ott","RB",143,"KC",5,16,null],
    [519,"Lil'Jordan Humphrey","WR",175,"DEN",10,16,-162],
    [520,"Michael Trigg","TE",81,"DAL",14,16,-86],
    [521,"Taysom Hill","TE",82,"FA",null,16,74],
  ];

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  // Turns FantasyPros' ECR-vs-ADP delta into the board's "value"/"sexy pick"
  // flags -- this is the data-driven stand-in for what used to be my own
  // hand-typed guesses. Positive delta = the field drafts him LATER than
  // consensus (he's likely to fall to you -- value); negative = the field
  // drafts him EARLIER than consensus (name-value outrunning the room's own
  // ranking -- the "sexy pick"/reach risk). The threshold loosens with depth
  // because a 6-spot swing at pick 8 is a real signal, while the same swing
  // at pick 400 is noise from a handful of ADP samples -- past rank 200 the
  // sample is too thin to trust either way, so no flag is assigned.
  function deriveFlags(rank, ecrVsAdp) {
    if (ecrVsAdp === null || rank > 200) return [];
    const threshold = rank <= 50 ? 6 : rank <= 100 ? 10 : 15;
    if (ecrVsAdp >= threshold) return ["value"];
    if (ecrVsAdp <= -threshold) return ["trap"];
    return [];
  }

  function makeSeedPlayers() {
    return SEED_PLAYERS.map((r) => {
      const [rank, name, pos, posRank, team, bye, tier, ecrVsAdp] = r;
      return {
        id: slugify(name + "-" + team + "-" + pos),
        name,
        pos,
        posRank,
        team,
        bye,
        tier,
        rank,
        ecrVsAdp,
        flags: deriveFlags(rank, ecrVsAdp),
      };
    });
  }

  function defaultState() {
    return {
      settings: { teams: 12, mySlot: 5, scoring: "PPR", draftType: "SNAKE", roster: Object.assign({}, DEFAULT_ROSTER), auctionBudget: 200 },
      players: makeSeedPlayers(),
      picks: [],
      ui: { posFilter: "ALL", search: "", hideDrafted: true, activeTab: "board" },
    };
  }

  const STORE_KEY = "edgerush_draft_v1";
  let state;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    state = raw ? JSON.parse(raw) : defaultState();
    if (!state || !state.settings || !state.players || !state.ui) state = defaultState();
  } catch (e) {
    state = defaultState(); // storage unavailable (private mode, quota, etc.) -- run in-memory only
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      /* ignore -- in-memory state still works for the rest of the session */
    }
  }

  /* ---------------- derived state ---------------- */

  function totalRounds() {
    return ROSTER_ORDER.reduce((sum, k) => sum + (state.settings.roster[k] || 0), 0);
  }

  // Standard snake order: odd rounds go slot 1->T, even rounds go T->1.
  function slotOnClock(overall, teams) {
    const round = Math.ceil(overall / teams);
    const posInRound = overall - (round - 1) * teams;
    return round % 2 === 1 ? posInRound : teams - posInRound + 1;
  }

  function currentOverall() {
    return state.picks.length + 1;
  }
  function currentRound(teams) {
    return Math.ceil(currentOverall() / teams);
  }

  function picksUntilMe() {
    const teams = state.settings.teams;
    const mine = state.settings.mySlot;
    let overall = currentOverall();
    if (slotOnClock(overall, teams) === mine) return 0;
    for (let count = 0; count < teams * 2; count++) {
      if (slotOnClock(overall, teams) === mine) return count;
      overall++;
    }
    return null;
  }

  function myPickSequence() {
    const teams = state.settings.teams;
    const mine = state.settings.mySlot;
    const rounds = totalRounds();
    const out = [];
    for (let round = 1; round <= rounds; round++) {
      const overall = round % 2 === 1 ? (round - 1) * teams + mine : (round - 1) * teams + (teams - mine + 1);
      out.push({ round, overall });
    }
    return out;
  }

  function playerById(id) {
    return state.players.find((p) => p.id === id) || null;
  }
  function pickFor(id) {
    return state.picks.find((p) => p.playerId === id) || null;
  }
  function isDrafted(id) {
    return !!pickFor(id);
  }

  // Assigns my picks to roster slots in draft order: natural position slot
  // first, then FLEX (RB/WR/TE only), then bench, then an overflow bench
  // slot if every configured bench spot is already full. Recomputed fresh
  // every render rather than stored, so changing the roster template
  // mid-draft can't leave stale assignments behind.
  function computeMyRoster() {
    const slots = [];
    ROSTER_ORDER.forEach((type) => {
      const n = state.settings.roster[type] || 0;
      for (let i = 0; i < n; i++) slots.push({ type, playerId: null });
    });
    state.picks
      .filter((p) => p.owner === "me")
      .forEach((pk) => {
        const pl = playerById(pk.playerId);
        if (!pl) return;
        let idx = slots.findIndex((s) => s.type === pl.pos && s.playerId === null);
        if (idx === -1 && ["RB", "WR", "TE"].includes(pl.pos)) {
          idx = slots.findIndex((s) => s.type === "FLEX" && s.playerId === null);
        }
        if (idx === -1) idx = slots.findIndex((s) => s.type === "BENCH" && s.playerId === null);
        if (idx === -1) {
          slots.push({ type: "BENCH", playerId: null, overflow: true });
          idx = slots.length - 1;
        }
        slots[idx].playerId = pk.playerId;
      });
    return slots;
  }

  function positionRunLastN(n) {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    state.picks.slice(-n).forEach((p) => {
      const pl = playerById(p.playerId);
      if (pl && counts.hasOwnProperty(pl.pos)) counts[pl.pos]++;
    });
    return counts;
  }

  function draftPhase(round, rounds) {
    if (round <= 3) return { label: "Foundation", text: "Best player available at RB/WR/TE. Resist the QB itch -- the position runs 15+ deep this year." };
    if (round <= 8) return { label: "Build", text: "Lock your starters. This is the window for a QB1 and your RB2/WR3 depth." };
    if (round <= Math.max(9, rounds - 4)) return { label: "Depth & bench", text: "Handcuffs with real standalone value, a TE2 if needed, high-upside bench flyers." };
    return { label: "Lottery tickets", text: "Rookie stashes, injury-comeback bets, and your DST/K -- last, always." };
  }

  function generateNudges() {
    const out = [];
    const myPicks = state.picks.filter((p) => p.owner === "me");
    const myPlayers = myPicks.map((p) => playerById(p.playerId)).filter(Boolean);
    const posCount = { QB: 0, RB: 0, WR: 0, TE: 0 };
    myPlayers.forEach((pl) => { if (posCount.hasOwnProperty(pl.pos)) posCount[pl.pos]++; });
    const teams = state.settings.teams;
    const round = currentRound(teams);
    const rounds = totalRounds();

    const last = myPlayers[myPlayers.length - 1];
    if (last && last.flags.includes("trap")) {
      out.push({ level: "danger", text: `"${last.name}" carries a boom/bust flag -- real name value, real bust risk. Watch early-season usage closely and don't be precious about benching or trading it.` });
    }
    if (posCount.QB === 0 && round <= 5) {
      out.push({ level: "good", text: "No QB yet -- that's fine. This position is 15+ deep; keep taking RB/WR value." });
    }
    if (posCount.QB === 0 && round >= 6 && round <= 10) {
      out.push({ level: "info", text: "Good window to grab your QB1 -- the Herbert/Lawrence/Goff/Purdy tier tends to fall right about here." });
    }
    if (posCount.QB >= 1) {
      const qbPick = myPicks.find((p) => { const pl = playerById(p.playerId); return pl && pl.pos === "QB"; });
      if (qbPick && Math.ceil(qbPick.overall / teams) <= 5) {
        out.push({ level: "warn", text: "You spent an early pick at QB -- make sure it's outproducing the RB/WR you passed on. Deep position this year, hold it to a high bar." });
      }
    }
    if (posCount.RB === 0 && round >= 4) {
      out.push({ level: "warn", text: "Zero RB territory now -- own it. Commit your next couple of picks to RB or the plan falls apart at the flex." });
    }
    const run = positionRunLastN(5);
    Object.keys(run).forEach((pos) => {
      if (run[pos] >= 3) out.push({ level: "danger", text: `${pos} run in progress -- ${run[pos]} of the last 5 picks. Decide now: get in on it or fade it and pivot.` });
    });
    if (round >= rounds - 2) {
      const openStarter = computeMyRoster().find((s) => s.playerId === null && s.type !== "BENCH");
      if (openStarter) out.push({ level: "danger", text: `Still an open starting ${openStarter.type} with the draft almost over -- don't punt it for a 4th bench flier.` });
    }
    const byeCounts = {};
    myPlayers.forEach((pl) => { if (pl.bye) byeCounts[pl.bye] = (byeCounts[pl.bye] || 0) + 1; });
    const crowdedBye = Object.keys(byeCounts).find((b) => byeCounts[b] >= 3);
    if (crowdedBye) {
      out.push({ level: "warn", text: `${byeCounts[crowdedBye]} of your players share bye week ${crowdedBye} -- check your bench depth at those positions before that week hits.` });
    }

    if (out.length === 0) out.push({ level: "info", text: "No alerts right now -- keep taking the best player on your board relative to tier, not name recognition." });
    return out.slice(0, 5);
  }

  /* ---------------- rendering ---------------- */

  function statCard(label, value, variant) {
    return `<div class="card stat-card${variant ? " " + variant : ""}"><div class="value mono">${value}</div><div class="label">${label}</div></div>`;
  }

  function renderScoreboard() {
    const teams = state.settings.teams;
    const overall = currentOverall();
    const round = currentRound(teams);
    const onClock = slotOnClock(overall, teams);
    const until = picksUntilMe();
    document.getElementById("scoreboard").innerHTML =
      statCard("Round", `${Math.min(round, totalRounds())} / ${totalRounds()}`) +
      statCard("Overall pick", overall) +
      statCard("On the clock", `Slot ${onClock}`, "warn") +
      statCard("Picks till you", until === 0 ? "YOU'RE UP" : until, until === 0 ? "danger" : "");
  }

  function renderSettingsForm() {
    document.getElementById("cfg-teams").value = state.settings.teams;
    document.getElementById("cfg-slot").value = state.settings.mySlot;
    document.getElementById("cfg-scoring").value = state.settings.scoring;
    document.getElementById("cfg-budget").value = state.settings.auctionBudget;
    document.getElementById("cfg-budget-control").style.display = state.settings.draftType === "AUCTION" ? "flex" : "none";
    document.querySelectorAll("#draft-type-toggle button").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === state.settings.draftType);
    });
    document.getElementById("roster-inputs").innerHTML = ROSTER_ORDER.map(
      (k) => `<div class="rf"><label>${k}</label><input type="number" min="0" max="10" data-rk="${k}" value="${state.settings.roster[k]}"></div>`
    ).join("");
  }

  function renderRosterList() {
    const slots = computeMyRoster();
    const round = currentRound(state.settings.teams);
    const rounds = totalRounds();
    document.getElementById("roster-list").innerHTML = slots.map((s) => {
      const pl = s.playerId ? playerById(s.playerId) : null;
      const urgent = !pl && round >= rounds - 3;
      return `<li style="display:flex; justify-content:space-between; gap:var(--space-2); font-size:0.85rem; ${urgent ? "color:var(--color-danger);" : ""}">
        <span class="mono text-faint">${s.type}</span>
        <span style="flex:1; text-align:right;">${pl ? Util.escapeHtml(pl.name) : "open"}</span>
      </li>`;
    }).join("");
  }

  function renderRunTracker() {
    const run = positionRunLastN(8);
    document.getElementById("run-tracker").innerHTML = ["QB", "RB", "WR", "TE"].map((pos) => {
      const c = run[pos];
      const pct = Math.round((c / 8) * 100);
      return `<div class="run-row">
        <span class="run-row__pos">${pos}</span>
        <span class="run-row__track"><span class="run-row__fill${c >= 3 ? " alert" : ""}" style="width:${pct}%"></span></span>
        <span class="run-row__count">${c}</span>
      </div>`;
    }).join("");
    const alertPos = ["QB", "RB", "WR", "TE"].find((p) => run[p] >= 3);
    document.getElementById("run-alert").innerHTML = alertPos
      ? `<p class="text-danger" style="margin:var(--space-2) 0 0; font-size:0.82rem;">${alertPos} run -- ${run[alertPos]} of the last 8 picks</p>`
      : "";
  }

  function renderPosFilter() {
    document.getElementById("pos-filter").innerHTML = POSES.map(
      (p) => `<button type="button" data-pos="${p}" class="${state.ui.posFilter === p ? "active" : ""}">${p}</button>`
    ).join("");
  }

  function tierBadgeClass(t) {
    return t === 1 ? "tier1" : t === 2 ? "tier2" : "neutral";
  }

  function renderBoard() {
    const q = state.ui.search.trim().toLowerCase();
    const rows = state.players
      .filter((p) => {
        if (state.ui.posFilter !== "ALL" && p.pos !== state.ui.posFilter) return false;
        if (q && !p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) return false;
        if (state.ui.hideDrafted && isDrafted(p.id)) return false;
        return true;
      })
      // Real consensus rank already reflects tier order -- sort on it
      // directly instead of tier+name so within-tier order matches the
      // actual board, falling back to name for any imported rows with no
      // rank (e.g. a hand-typed CSV).
      .sort((a, b) => (a.rank || 9999) - (b.rank || 9999) || a.name.localeCompare(b.name));

    const body = document.getElementById("board-body");
    if (rows.length === 0) {
      body.innerHTML = `<tr><td colspan="6"><div class="empty-state">No players match -- clear filters or import a fresh board.</div></td></tr>`;
      return;
    }

    body.innerHTML = rows.map((p) => {
      const drafted = isDrafted(p.id);
      const pk = drafted ? pickFor(p.id) : null;
      const flagsHtml = p.flags.map((f) => {
        const meta = FLAG_META[f] || ["neutral", f];
        return `<span class="badge ${meta[0]}">${meta[1]}</span>`;
      }).join(" ");
      const posLabel = p.posRank ? `${p.pos}${p.posRank}` : p.pos;

      let actionHtml;
      if (drafted) {
        actionHtml = `<span class="text-faint">${pk.owner === "me" ? "YOUR PICK" : "gone"}${pk.paid ? ` &middot; $${pk.paid}` : ""}</span>`;
      } else if (state.settings.draftType === "AUCTION") {
        actionHtml = `<span class="auction-bid">$<input type="number" min="1" max="${state.settings.auctionBudget}" value="1" data-bidfor="${p.id}">
          <button type="button" class="btn" data-act="mine-auction" data-id="${p.id}">Mine</button>
          <button type="button" class="btn" data-act="gone" data-id="${p.id}">Gone</button></span>`;
      } else {
        actionHtml = `<button type="button" class="btn" data-act="mine" data-id="${p.id}">Mine</button>
          <button type="button" class="btn" data-act="gone" data-id="${p.id}">Gone</button>`;
      }

      return `<tr${drafted ? ' style="opacity:0.4;"' : ""}>
        <td><span class="badge ${tierBadgeClass(p.tier)}">T${p.tier}</span></td>
        <td>${drafted ? `<s>${Util.escapeHtml(p.name)}</s>` : Util.escapeHtml(p.name)} <span class="text-faint">${posLabel}</span></td>
        <td>${Util.escapeHtml(p.team)}</td>
        <td>${p.bye || "&ndash;"}</td>
        <td>${flagsHtml}</td>
        <td style="text-align:right;">${actionHtml}</td>
      </tr>`;
    }).join("");
  }

  function findNextMine(seq, overall) {
    const next = seq.find((s) => s.overall >= overall);
    return next ? next.overall : null;
  }

  function renderMyDraft() {
    const teams = state.settings.teams;
    const round = currentRound(teams);
    const rounds = totalRounds();
    const phase = draftPhase(round, rounds);
    document.getElementById("phase-banner").innerHTML = `<strong>R${Math.min(round, rounds)} — ${phase.label}.</strong> ${phase.text}`;

    document.getElementById("nudges").innerHTML = generateNudges().map(
      (n) => `<div class="banner ${n.level} tight">${n.text}</div>`
    ).join("");

    const seq = myPickSequence();
    const overall = currentOverall();
    const nextMine = findNextMine(seq, overall);
    document.getElementById("pick-list").innerHTML = seq.map((s) => {
      const cls = s.overall < overall ? "done" : s.overall === nextMine ? "next" : "";
      return `<span class="chip ${cls}">R${s.round} &middot; #${s.overall}</span>`;
    }).join("");

    document.getElementById("roster-board").innerHTML = computeMyRoster().map((s) => {
      const pl = s.playerId ? playerById(s.playerId) : null;
      const cls = pl ? "filled" : round >= rounds - 3 ? "urgent" : "";
      return `<div class="roster-slot ${cls}"><div class="roster-slot__type">${s.type}</div><div class="roster-slot__name">${pl ? Util.escapeHtml(pl.name) : "Open"}</div></div>`;
    }).join("");
  }

  function renderAuctionTab() {
    const spent = state.picks.filter((p) => p.owner === "me" && p.paid).reduce((a, p) => a + p.paid, 0);
    const budget = state.settings.auctionBudget;
    const remaining = budget - spent;
    const mySlots = computeMyRoster();
    const filled = mySlots.filter((s) => s.playerId).length;
    const slotsLeft = Math.max(1, mySlots.length - filled);
    const maxBid = Math.max(1, remaining - (slotsLeft - 1));
    document.getElementById("auction-stats").innerHTML =
      statCard("Budget", "$" + budget) +
      statCard("Spent", "$" + spent) +
      statCard("Remaining", "$" + remaining, "warn") +
      statCard("Max sensible bid", "$" + maxBid);
  }

  const STRATEGY_HTML = `
    <article>
      <h2>Round by round</h2>
      <p>Think of a draft in four phases, not twelve or sixteen individual picks. <strong>Foundation (rounds 1&ndash;3):</strong>
        take the best RB/WR/TE on your board &mdash; pure talent and volume, no position requirement.
        <strong>Build (rounds 4&ndash;8):</strong> lock starters, including your QB1 if you waited.
        <strong>Depth &amp; bench (rounds 9 to about four-from-the-end):</strong> handcuffs with real standalone
        value, a TE2 if your TE1 is boom/bust, high-upside bench pieces. <strong>Lottery tickets (final rounds):</strong>
        rookie stashes, comeback bets, and only then your DST/K.</p>
      <div class="pullquote">The single biggest mistake in fantasy drafts isn't one bad pick &mdash; it's panicking
        into position runs that were never yours to chase.</div>

      <h2>Don't draft a QB in round 1 (or usually before round 6)</h2>
      <p>In a 1-QB league, the position is absurdly deep. A dozen-plus quarterbacks finish as viable weekly starters,
        and several of them (Goff, Purdy, Lawrence, Herbert-type profiles) are available five or six rounds after
        the "elite" tier goes off the board. Spending a top-24 pick on a QB means passing on a bell-cow RB or true
        WR1 for positional value you could have had at half the cost. The math only flips in
        <strong>superflex/2-QB</strong> leagues, where QBs become legitimately scarce and early investment is correct.</p>

      <h2>Hero RB, Zero RB, or balanced?</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Build</th><th>Idea</th><th>Best case</th><th>Worst case</th></tr></thead>
          <tbody>
            <tr><td>Hero RB</td><td>One elite bell-cow early, then pivot hard to WR/TE for several rounds</td>
              <td>True RB1 production without punting the receiver corps</td>
              <td>Your one RB gets hurt and you're replacing a foundation piece, not a luxury</td></tr>
            <tr><td>Zero RB</td><td>Ignore RB early, stack elite WRs, mine RB value from rounds 8&ndash;13</td>
              <td>WRs are more likely to hold their draft-day value than RBs &mdash; you bank stability</td>
              <td>If your late-round RB bets whiff, you're starting waiver-wire backs at your flex all year</td></tr>
            <tr><td>Balanced / BPA</td><td>Fill RB and WR need as value dictates, no fixed plan</td>
              <td>Simple, adapts to how the room actually drafts</td>
              <td>No plan means no edge &mdash; you can drift into thin at both spots</td></tr>
          </tbody>
        </table>
      </div>
      <p>None of these is "correct" in the abstract &mdash; they're responses to how RBs get hurt and lose touches
        more than WRs do. Pick a lane based on what falls to you in rounds 1&ndash;2, don't force it.</p>

      <h2>Avoiding the sexy pick</h2>
      <p>ADP is a popularity contest as much as a talent ranking. A player's draft position often reflects
        <em>last year's</em> highlight reel more than this year's actual opportunity &mdash; rookies with a hot
        preseason, a name you recognize from a big game, a "buy low" narrative that's really just hope. The fix
        isn't to avoid these players entirely; it's to price them at their tier, not their name.</p>
      <div class="card">
        <p style="margin:0;"><strong>Watch for the flag:</strong> players tagged <span class="badge negative">&#9888; sexy pick</span>
          on the board carry real name-value but a track record of hype outrunning production &mdash; boom/bust
          rookies off one big preseason, or aging stars whose role has quietly shrunk. Draft them where their tier
          says to, not where the buzz says to.</p>
      </div>

      <h2>Roster construction rules that hold up</h2>
      <p>Don't handcuff your own RB1 in the double-digit rounds &mdash; a backup with no standalone value is a
        wasted pick nine times out of ten; spend that pick on a player who helps you even if nothing changes
        upstairs. Reinforce WR depth all draft: when a starting WR gets hurt, the vacated targets usually scatter
        across two or three teammates rather than consolidating into one obvious must-add, so bench WR depth
        matters more than bench RB depth. And build a roster that survives losing your best player for a month,
        not a roster that only wins if everything breaks right.</p>

      <h2>In-draft discipline</h2>
      <p>Value relative to ADP beats need on paper &mdash; but need wins ties. If two players grade out equally on
        your board and one fills an empty starting spot, take that one. And when three of the same position leave
        the board in five picks, don't assume you have to follow: check whether the run is actually about to reach
        your tier, or whether it's early panic from teams two picks ahead of the value cliff.</p>
    </article>
    <aside class="card">
      <h3>Quick reference</h3>
      <ul>
        <li>QB before round 6 in 1-QB leagues: almost never worth it.</li>
        <li>One elite RB early beats zero elite RBs &mdash; but two isn't automatically better than one plus a stacked WR corps.</li>
        <li>Handcuffs: skip unless the backup has standalone value.</li>
        <li>DST/K: last two picks, always. Stream DST off matchups all season.</li>
        <li>A "sexy pick" flag means check the tier before you reach, not skip the player.</li>
      </ul>
    </aside>
  `;

  const AUCTION_ARTICLE_HTML = `
    <article style="max-width:66ch;">
      <h2>Auction strategy, short version</h2>
      <p><strong>Stars &amp; scrubs</strong> vs <strong>balanced</strong> is the real fork in the road.
        Stars-and-scrubs spends 60%+ of your budget on two or three elite players and fills the rest with $1
        flyers; balanced spreads $15&ndash;30 across six or seven solid starters. Balanced is more forgiving of one
        bad pick; stars-and-scrubs has a higher ceiling but one bust tanks your team.</p>
      <p><strong>Nominate players you don't want.</strong> Throwing out a name you have no interest in, early,
        drains other teams' budgets on someone who isn't going to help you. Save your actual targets for the
        middle third of the auction, once budgets are already dented.</p>
      <p><strong>Price enforcement.</strong> If a player is going for less than they're worth, bid it up even if
        you don't plan to buy &mdash; it forces the eventual buyer to spend more of their budget, which helps you
        later. Stop before the price you'd actually pay.</p>
      <p><strong>The $1 reserve rule.</strong> Never let your remaining budget dip below $1 per remaining roster
        slot. The Max sensible bid tile above already backs that reserve out for you.</p>
    </article>
  `;

  function render() {
    renderScoreboard();
    renderSettingsForm();
    renderRosterList();
    renderRunTracker();
    renderPosFilter();
    renderBoard();
    renderMyDraft();
    renderAuctionTab();
    document.getElementById("strategy-layout").innerHTML = STRATEGY_HTML;
    document.getElementById("auction-article").innerHTML = AUCTION_ARTICLE_HTML;
    save();
  }

  /* ---------------- actions ---------------- */

  function draftPlayer(id, owner, paid) {
    if (isDrafted(id)) return;
    state.picks.push({ overall: currentOverall(), playerId: id, owner, paid: paid || null });
    render();
  }

  function undoLast() {
    if (state.picks.length === 0) return;
    state.picks.pop();
    render();
  }

  document.getElementById("board-body").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === "mine") draftPlayer(id, "me");
    else if (act === "gone") draftPlayer(id, "other");
    else if (act === "mine-auction") {
      const input = document.querySelector(`input[data-bidfor="${id}"]`);
      const amt = Math.max(1, parseInt(input && input.value, 10) || 1);
      draftPlayer(id, "me", amt);
    }
  });

  document.getElementById("pos-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pos]");
    if (!b) return;
    state.ui.posFilter = b.dataset.pos;
    renderPosFilter();
    renderBoard();
    save();
  });

  document.getElementById("search-box").addEventListener("input", (e) => {
    state.ui.search = e.target.value;
    renderBoard();
    save();
  });

  document.getElementById("hide-drafted").addEventListener("change", (e) => {
    state.ui.hideDrafted = e.target.checked;
    renderBoard();
    save();
  });

  document.getElementById("draft-type-toggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-type]");
    if (!b) return;
    state.settings.draftType = b.dataset.type;
    renderSettingsForm();
    renderBoard();
    save();
  });

  document.getElementById("btn-apply").addEventListener("click", () => {
    const teams = parseInt(document.getElementById("cfg-teams").value, 10) || 12;
    let slot = parseInt(document.getElementById("cfg-slot").value, 10) || 1;
    if (slot > teams) slot = teams;
    state.settings.teams = teams;
    state.settings.mySlot = slot;
    state.settings.scoring = document.getElementById("cfg-scoring").value;
    state.settings.auctionBudget = parseInt(document.getElementById("cfg-budget").value, 10) || 200;
    document.querySelectorAll("#roster-inputs input").forEach((inp) => {
      state.settings.roster[inp.dataset.rk] = parseInt(inp.value, 10) || 0;
    });
    render();
  });

  document.getElementById("btn-reset-draft").addEventListener("click", () => {
    state.picks = [];
    render();
  });

  let fullResetArmed = false;
  const fullResetBtn = document.getElementById("btn-full-reset");
  fullResetBtn.addEventListener("click", () => {
    if (!fullResetArmed) {
      fullResetArmed = true;
      fullResetBtn.textContent = "Click again to confirm";
      setTimeout(() => { fullResetArmed = false; fullResetBtn.textContent = "Factory reset"; }, 4000);
      return;
    }
    state = defaultState();
    fullResetArmed = false;
    fullResetBtn.textContent = "Factory reset";
    render();
  });

  function parseCsv(text) {
    return text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(",").map((s) => s.trim()))
      .filter((parts) => parts.length >= 3 && parts[0] && parts[0].toLowerCase() !== "name")
      .map((parts) => ({
        id: slugify(parts[0] + "-" + (parts[2] || "") + "-" + (parts[1] || "")),
        name: parts[0],
        pos: (parts[1] || "").toUpperCase(),
        team: parts[2] || "",
        tier: parseInt(parts[3], 10) || 9,
        flags: parts[4] ? parts[4].split("|").map((s) => s.trim()).filter(Boolean) : [],
        bye: parts[5] ? parseInt(parts[5], 10) || null : null,
        rank: null,
        posRank: null,
        ecrVsAdp: null,
      }));
  }

  document.getElementById("btn-import").addEventListener("click", () => {
    const text = document.getElementById("import-box").value;
    const players = parseCsv(text);
    if (players.length === 0) return;
    state.players = players;
    render();
  });

  function currentBoardCsv() {
    const rows = ["name,pos,team,tier,flags,bye,status,owner,paid"];
    state.players.forEach((p) => {
      const pk = pickFor(p.id);
      rows.push([p.name, p.pos, p.team, p.tier, p.flags.join("|"), p.bye || "", pk ? "drafted" : "available", pk ? pk.owner : "", pk && pk.paid ? pk.paid : ""].join(","));
    });
    return rows.join("\n");
  }

  document.getElementById("btn-export-download").addEventListener("click", () => {
    const blob = new Blob([currentBoardCsv()], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "draft-board.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById("btn-export-show").addEventListener("click", () => {
    const box = document.getElementById("import-box");
    box.value = currentBoardCsv();
    box.focus();
    box.select();
  });

  document.getElementById("tab-toggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    document.querySelectorAll("#tab-toggle button").forEach((x) => x.classList.toggle("active", x === b));
    ["board", "mydraft", "strategy", "auction"].forEach((t) => {
      document.getElementById("tab-" + t).style.display = t === b.dataset.tab ? "" : "none";
    });
    state.ui.activeTab = b.dataset.tab;
    const p = new URLSearchParams(location.search);
    p.set("tab", b.dataset.tab);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
    save();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "z" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      undoLast();
    }
  });

  /* ---------------- init ---------------- */
  const initialTab = new URLSearchParams(location.search).get("tab") || state.ui.activeTab || "board";
  const initialBtn = document.querySelector(`#tab-toggle button[data-tab="${initialTab}"]`);
  if (initialBtn) initialBtn.click();

  render();
})();

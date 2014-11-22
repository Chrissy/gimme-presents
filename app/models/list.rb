class List < ActiveRecord::Base
  has_many :gifts
  
  def url
    "/#{id}"
  end
  
  def edit_link
    "/edit/#{id}"
  end
end